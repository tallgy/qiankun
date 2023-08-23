/* eslint-disable no-param-reassign */
import { without } from 'lodash';
/**
 * @author Kuitos
 * @since 2020-3-31
 */
import type { SandBox } from '../interfaces';
import { SandBoxType } from '../interfaces';
import { isPropertyFrozen, nativeGlobal, nextTask } from '../utils';
import { clearCurrentRunningApp, getCurrentRunningApp, getTargetValue, setCurrentRunningApp } from './common';
import { globals } from './globals';

type SymbolTarget = 'target' | 'globalContext';

type FakeWindow = Window & Record<PropertyKey, any>;

/**
 * fastest(at most time) unique array method
 * @see https://jsperf.com/array-filter-unique/30
 */
function uniq(array: Array<string | symbol>) {
  return array.filter(function filter(this: PropertyKey[], element) {
    return element in this ? false : ((this as any)[element] = true);
  }, Object.create(null));
}

// zone.js will overwrite Object.defineProperty
const rawObjectDefineProperty = Object.defineProperty;

const variableWhiteListInDev =
  process.env.NODE_ENV === 'test' || process.env.NODE_ENV === 'development' || window.__QIANKUN_DEVELOPMENT__
    ? [
        // for react hot reload
        // see https://github.com/facebook/create-react-app/blob/66bf7dfc43350249e2f09d138a20840dae8a0a4a/packages/react-error-overlay/src/index.js#L180
        '__REACT_ERROR_OVERLAY_GLOBAL_HOOK__',
        // for react development event issue, see https://github.com/umijs/qiankun/issues/2375
        'event',
      ]
    : [];
// who could escape the sandbox
const globalVariableWhiteList: string[] = [
  // FIXME System.js used a indirect call with eval, which would make it scope escape to global
  // To make System.js works well, we write it back to global window temporary
  // see https://github.com/systemjs/systemjs/blob/457f5b7e8af6bd120a279540477552a07d5de086/src/evaluate.js#L106
  'System',

  // see https://github.com/systemjs/systemjs/blob/457f5b7e8af6bd120a279540477552a07d5de086/src/instantiate.js#L357
  '__cjsWrapper',
  ...variableWhiteListInDev,
];

const inTest = process.env.NODE_ENV === 'test';
const mockSafariTop = 'mockSafariTop';
const mockTop = 'mockTop';
const mockGlobalThis = 'mockGlobalThis';

// these globals should be recorded while accessing every time
const accessingSpiedGlobals = ['document', 'top', 'parent', 'eval'];
const overwrittenGlobals = ['window', 'self', 'globalThis', 'hasOwnProperty'].concat(inTest ? [mockGlobalThis] : []);
export const cachedGlobals = Array.from(
  new Set(without(globals.concat(overwrittenGlobals).concat('requestAnimationFrame'), ...accessingSpiedGlobals)),
);

// transform cachedGlobals to object for faster element check
const cachedGlobalObjects = cachedGlobals.reduce((acc, globalProp) => ({ ...acc, [globalProp]: true }), {});

/*
 Variables who are impossible to be overwritten need to be escaped from proxy sandbox for performance reasons.
 But overwritten globals must not be escaped, otherwise they will be leaked to the global scope.
 see https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Symbol/unscopables
 */
const unscopables = without(cachedGlobals, ...accessingSpiedGlobals.concat(overwrittenGlobals)).reduce(
  (acc, key) => ({ ...acc, [key]: true }),
  // Notes that babel will transpile spread operator to Object.assign({}, ...args), which will keep the prototype of Object in merged object,
  // while this result used as Symbol.unscopables, it will make properties in Object.prototype always be escaped from proxy sandbox as unscopables check will look up prototype chain as well,
  // such as hasOwnProperty, toString, valueOf, etc.
  // so we should use Object.create(null) to create a pure object without prototype chain here.
  Object.create(null),
);

const useNativeWindowForBindingsProps = new Map<PropertyKey, boolean>([
  ['fetch', true],
  ['mockDomAPIInBlackList', process.env.NODE_ENV === 'test'],
]);

/**
 * 将global的不可配置属性复制到fakeWindow 
 * 并且将属性存在 get 方法的属性 放入 propertiesWithGetter 值为 true
 * @param globalContext 
 * @param speedy 
 * @returns 
 */
function createFakeWindow(globalContext: Window, speedy: boolean) {
  // map always has the fastest performance in has check scenario
  // Map 总是有最快的性能在检查场景
  // see https://jsperf.com/array-indexof-vs-set-has/23
  const propertiesWithGetter = new Map<PropertyKey, boolean>();
  const fakeWindow = {} as FakeWindow;

  /*
   copy the non-configurable property of global to fakeWindow
   将global的不可配置属性复制到fakeWindow 但是只是自身的属性，没有考虑到 prototype
   see https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Proxy/handler/getOwnPropertyDescriptor
   > A property cannot be reported as non-configurable, if it does not exist as an own property of the target object or if it exists as a configurable own property of the target object.
   如果属性不作为目标对象的自有属性存在，或者作为目标对象的可配置自有属性存在，则不能将其报告为不可配置的属性。
   */
  Object.getOwnPropertyNames(globalContext)
    // 获取不可配置的属性
    .filter((p) => {
      // configurable ：当且仅当此属性描述符的类型可以更改且该属性可以从相应对象中删除时，为 true。
      const descriptor = Object.getOwnPropertyDescriptor(globalContext, p);
      return !descriptor?.configurable;
    })
    .forEach((p) => {
      const descriptor = Object.getOwnPropertyDescriptor(globalContext, p);
      // 如果存在 descriptor
      if (descriptor) {
        // 如果重写了 get 方法
        const hasGetter = Object.prototype.hasOwnProperty.call(descriptor, 'get');

        /*
         make top/self/window property configurable and writable, otherwise it will cause TypeError while get trap return.
         使 top/self/window 属性可配置且可写，否则在 get trap返回时将导致TypeError。
         see https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Proxy/handler/get
         > The value reported for a property must be the same as the value of the corresponding target object property if the target object property is a non-writable, non-configurable data property.
         如果目标对象属性是不可写、不可配置的数据属性，则属性报告的值必须与相应的目标对象属性的值相同。
         */
        if (
          p === 'top' ||
          p === 'parent' ||
          p === 'self' ||
          p === 'window' ||
          // window.document is overwriting in speedy mode
          // 在快速模式下覆盖
          (p === 'document' && speedy) ||
          (inTest && (p === mockTop || p === mockSafariTop))
        ) {
          descriptor.configurable = true;
          /*
           The descriptor of window.window/window.top/window.self in Safari/FF are accessor descriptors, we need to avoid adding a data descriptor while it was
           Example:
           window.window/window.top/window的描述符。在Safari/FF中，self都是访问器描述符，我们需要避免添加数据描述符
            Safari/FF: Object.getOwnPropertyDescriptor(window, 'top') -> {get: function, set: undefined, enumerable: true, configurable: false}
            Chrome: Object.getOwnPropertyDescriptor(window, 'top') -> {value: Window, writable: false, enumerable: true, configurable: false}
           */
          // 如果 没有 get 方法，那么将 writable 设置为true
          // 不知道其作用是什么
          if (!hasGetter) {
            descriptor.writable = true;
          }
        }

        // 存在 getter 方法
        if (hasGetter) propertiesWithGetter.set(p, true);

        // freeze the descriptor to avoid being modified by zone.js
        // 冻结描述符以避免被 zone.js 修改    rawObjectDefineProperty 就是 defineProperty
        // see https://github.com/angular/zone.js/blob/a5fe09b0fac27ac5df1fa746042f96f05ccb6a00/lib/browser/define-property.ts#L71
        rawObjectDefineProperty(fakeWindow, p, Object.freeze(descriptor));
      }
    });

  return {
    fakeWindow,
    propertiesWithGetter,
  };
}

let activeSandboxCount = 0;

/**
 * 基于 Proxy 实现的沙箱
 */
export default class ProxySandbox implements SandBox {
  /** window 值变更记录 */
  private updatedValueSet = new Set<PropertyKey>();
  private document = document;
  name: string;
  type: SandBoxType;
  proxy: WindowProxy;
  sandboxRunning = true;
  latestSetProp: PropertyKey | null = null;

  active() {
    if (!this.sandboxRunning) activeSandboxCount++;
    this.sandboxRunning = true;
  }

  inactive() {
    if (process.env.NODE_ENV === 'development') {
      console.info(`[qiankun:sandbox] ${this.name} modified global properties restore...`, [
        ...this.updatedValueSet.keys(),
      ]);
    }

    if (inTest || --activeSandboxCount === 0) {
      // reset the global value to the prev value
      Object.keys(this.globalWhitelistPrevDescriptor).forEach((p) => {
        const descriptor = this.globalWhitelistPrevDescriptor[p];
        if (descriptor) {
          Object.defineProperty(this.globalContext, p, descriptor);
        } else {
          // @ts-ignore
          delete this.globalContext[p];
        }
      });
    }

    this.sandboxRunning = false;
  }

  public patchDocument(doc: Document) {
    this.document = doc;
  }

  // the descriptor of global variables in whitelist before it been modified
  globalWhitelistPrevDescriptor: { [p in (typeof globalVariableWhiteList)[number]]: PropertyDescriptor | undefined } =
    {};
  globalContext: typeof window;

  constructor(name: string, globalContext = window, opts?: { speedy: boolean }) {
    this.name = name;
    this.globalContext = globalContext;
    this.type = SandBoxType.Proxy;
    const { updatedValueSet } = this;
    const { speedy } = opts || {};

    const { fakeWindow, propertiesWithGetter } = createFakeWindow(globalContext, !!speedy);

    const descriptorTargetMap = new Map<PropertyKey, SymbolTarget>();

    const proxy = new Proxy(fakeWindow, {
      set: (target: FakeWindow, p: PropertyKey, value: any): boolean => {
        if (this.sandboxRunning) {
          this.registerRunningApp(name, proxy);

          // sync the property to globalContext
          if (typeof p === 'string' && globalVariableWhiteList.indexOf(p) !== -1) {
            this.globalWhitelistPrevDescriptor[p] = Object.getOwnPropertyDescriptor(globalContext, p);
            // @ts-ignore
            globalContext[p] = value;
          } else {
            // We must keep its description while the property existed in globalContext before
            if (!target.hasOwnProperty(p) && globalContext.hasOwnProperty(p)) {
              const descriptor = Object.getOwnPropertyDescriptor(globalContext, p);
              const { writable, configurable, enumerable, set } = descriptor!;
              // only writable property can be overwritten
              // here we ignored accessor descriptor of globalContext as it makes no sense to trigger its logic(which might make sandbox escaping instead)
              // we force to set value by data descriptor
              if (writable || set) {
                Object.defineProperty(target, p, { configurable, enumerable, writable: true, value });
              }
            } else {
              target[p] = value;
            }
          }

          updatedValueSet.add(p);

          this.latestSetProp = p;

          return true;
        }

        if (process.env.NODE_ENV === 'development') {
          console.warn(`[qiankun] Set window.${p.toString()} while sandbox destroyed or inactive in ${name}!`);
        }

        // 在 strict-mode 下，Proxy 的 handler.set 返回 false 会抛出 TypeError，在沙箱卸载的情况下应该忽略错误
        return true;
      },

      get: (target: FakeWindow, p: PropertyKey): any => {
        this.registerRunningApp(name, proxy);

        if (p === Symbol.unscopables) return unscopables;
        // avoid who using window.window or window.self to escape the sandbox environment to touch the real window
        // see https://github.com/eligrey/FileSaver.js/blob/master/src/FileSaver.js#L13
        if (p === 'window' || p === 'self') {
          return proxy;
        }

        // hijack globalWindow accessing with globalThis keyword
        if (p === 'globalThis' || (inTest && p === mockGlobalThis)) {
          return proxy;
        }

        if (p === 'top' || p === 'parent' || (inTest && (p === mockTop || p === mockSafariTop))) {
          // if your master app in an iframe context, allow these props escape the sandbox
          if (globalContext === globalContext.parent) {
            return proxy;
          }
          return (globalContext as any)[p];
        }

        // proxy.hasOwnProperty would invoke getter firstly, then its value represented as globalContext.hasOwnProperty
        if (p === 'hasOwnProperty') {
          return hasOwnProperty;
        }

        if (p === 'document') {
          return this.document;
        }

        if (p === 'eval') {
          return eval;
        }

        if (p === 'string' && globalVariableWhiteList.indexOf(p) !== -1) {
          // @ts-ignore
          return globalContext[p];
        }

        const actualTarget = propertiesWithGetter.has(p) ? globalContext : p in target ? target : globalContext;
        const value = actualTarget[p];

        // frozen value should return directly, see https://github.com/umijs/qiankun/issues/2015
        if (isPropertyFrozen(actualTarget, p)) {
          return value;
        }

        /* Some dom api must be bound to native window, otherwise it would cause exception like 'TypeError: Failed to execute 'fetch' on 'Window': Illegal invocation'
           See this code:
             const proxy = new Proxy(window, {});
             const proxyFetch = fetch.bind(proxy);
             proxyFetch('https://qiankun.com');
        */
        const boundTarget = useNativeWindowForBindingsProps.get(p) ? nativeGlobal : globalContext;
        return getTargetValue(boundTarget, value);
      },

      // trap in operator
      // see https://github.com/styled-components/styled-components/blob/master/packages/styled-components/src/constants.js#L12
      has(target: FakeWindow, p: string | number | symbol): boolean {
        // property in cachedGlobalObjects must return true to avoid escape from get trap
        return p in cachedGlobalObjects || p in target || p in globalContext;
      },

      getOwnPropertyDescriptor(target: FakeWindow, p: string | number | symbol): PropertyDescriptor | undefined {
        /*
         as the descriptor of top/self/window/mockTop in raw window are configurable but not in proxy target, we need to get it from target to avoid TypeError
         see https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Proxy/handler/getOwnPropertyDescriptor
         > A property cannot be reported as non-configurable, if it does not exist as an own property of the target object or if it exists as a configurable own property of the target object.
         */
        if (target.hasOwnProperty(p)) {
          const descriptor = Object.getOwnPropertyDescriptor(target, p);
          descriptorTargetMap.set(p, 'target');
          return descriptor;
        }

        if (globalContext.hasOwnProperty(p)) {
          const descriptor = Object.getOwnPropertyDescriptor(globalContext, p);
          descriptorTargetMap.set(p, 'globalContext');
          // A property cannot be reported as non-configurable, if it does not exist as an own property of the target object
          if (descriptor && !descriptor.configurable) {
            descriptor.configurable = true;
          }
          return descriptor;
        }

        return undefined;
      },

      // trap to support iterator with sandbox
      ownKeys(target: FakeWindow): ArrayLike<string | symbol> {
        return uniq(Reflect.ownKeys(globalContext).concat(Reflect.ownKeys(target)));
      },

      defineProperty: (target: Window, p: PropertyKey, attributes: PropertyDescriptor): boolean => {
        const from = descriptorTargetMap.get(p);
        /*
         Descriptor must be defined to native window while it comes from native window via Object.getOwnPropertyDescriptor(window, p),
         otherwise it would cause a TypeError with illegal invocation.
         */
        switch (from) {
          case 'globalContext':
            return Reflect.defineProperty(globalContext, p, attributes);
          default:
            return Reflect.defineProperty(target, p, attributes);
        }
      },

      deleteProperty: (target: FakeWindow, p: string | number | symbol): boolean => {
        this.registerRunningApp(name, proxy);
        if (target.hasOwnProperty(p)) {
          // @ts-ignore
          delete target[p];
          updatedValueSet.delete(p);

          return true;
        }

        return true;
      },

      // makes sure `window instanceof Window` returns truthy in micro app
      getPrototypeOf() {
        return Reflect.getPrototypeOf(globalContext);
      },
    });

    this.proxy = proxy;

    activeSandboxCount++;

    function hasOwnProperty(this: any, key: PropertyKey): boolean {
      // calling from hasOwnProperty.call(obj, key)
      if (this !== proxy && this !== null && typeof this === 'object') {
        return Object.prototype.hasOwnProperty.call(this, key);
      }

      return fakeWindow.hasOwnProperty(key) || globalContext.hasOwnProperty(key);
    }
  }

  /**
   * 更新目前被运行的app
   * 同时每次 微任务之后都要去 清除 不知道这个的原因是什么。。
   * @param name 
   * @param proxy 
   */
  private registerRunningApp(name: string, proxy: Window) {
    if (this.sandboxRunning) {
      const currentRunningApp = getCurrentRunningApp();
      // 更新 目前被运行的 app 如果是这个，表明了，同时只能一次只能运行一个app
      if (!currentRunningApp || currentRunningApp.name !== name) {
        setCurrentRunningApp({ name, window: proxy });
      }
      // FIXME if you have any other good ideas
      // remove the mark in next tick, thus we can identify whether it in micro app or not
      // this approach is just a workaround, it could not cover all complex cases, such as the micro app runs in the same task context with master in some case
      // 如果你有任何其他好的想法，请删除下一个tick中的标记，
      // 这样我们就可以确定它是否在微应用中，这种方法只是一种变通方法，它不能涵盖所有复杂的情况，例如微应用在某些情况下与master运行在相同的任务上下文中
      // 微任务
      nextTask(clearCurrentRunningApp);
    }
  }
}
