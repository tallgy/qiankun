/**
 * @author Kuitos
 * @since 2019-04-11
 */
import type { SandBox } from '../../interfaces';
import { SandBoxType } from '../../interfaces';
import { getTargetValue } from '../common';

function isPropConfigurable(target: WindowProxy, prop: PropertyKey) {
  const descriptor = Object.getOwnPropertyDescriptor(target, prop);
  return descriptor ? descriptor.configurable : true;
}

/**
 * 基于 Proxy 实现的沙箱
 * name: 沙箱名字
 * context：沙箱所依赖的全局变量
 * TODO: 为了兼容性 singular 模式下依旧使用该沙箱，等新沙箱稳定之后再切换
 */
export default class LegacySandbox implements SandBox {
  /** 沙箱期间新增的全局变量 */
  private addedPropsMapInSandbox = new Map<PropertyKey, any>();

  /** 沙箱期间更新的全局变量 */
  private modifiedPropsOriginalValueMapInSandbox = new Map<PropertyKey, any>();

  /** 持续记录更新的(新增和修改的)全局变量的 map，用于在任意时刻做 snapshot */
  private currentUpdatedPropsValueMap = new Map<PropertyKey, any>();

  name: string;

  proxy: WindowProxy;

  globalContext: typeof window;

  type: SandBoxType;

  sandboxRunning = true;

  latestSetProp: PropertyKey | null = null;

  private setWindowProp(prop: PropertyKey, value: any, toDelete?: boolean) {
    if (value === undefined && toDelete) {
      // eslint-disable-next-line no-param-reassign
      delete (this.globalContext as any)[prop];
    } else if (isPropConfigurable(this.globalContext, prop) && typeof prop !== 'symbol') {
      Object.defineProperty(this.globalContext, prop, { writable: true, configurable: true });
      // eslint-disable-next-line no-param-reassign
      (this.globalContext as any)[prop] = value;
    }
  }

  /** 激活 将 currentUpdatedPropsValueMap 更新到 全局 */
  active() {
    if (!this.sandboxRunning) {
      this.currentUpdatedPropsValueMap.forEach((v, p) => this.setWindowProp(p, v));
    }

    this.sandboxRunning = true;
  }

  /** 不激活 */
  inactive() {
    // renderSandboxSnapshot = snapshot(currentUpdatedPropsValueMapForSnapshot);
    // restore global props to initial snapshot
    // 将全局道具恢复到初始快照
    // 这个将所有值恢复原始状态
    this.modifiedPropsOriginalValueMapInSandbox.forEach((v, p) => this.setWindowProp(p, v));
    // 这个将所有新增的值，删除
    this.addedPropsMapInSandbox.forEach((_, p) => this.setWindowProp(p, undefined, true));

    this.sandboxRunning = false;
  }

  constructor(name: string, globalContext = window) {
    this.name = name;
    this.globalContext = globalContext;
    this.type = SandBoxType.LegacyProxy;
    const { addedPropsMapInSandbox, modifiedPropsOriginalValueMapInSandbox, currentUpdatedPropsValueMap } = this;

    const rawWindow = globalContext;
    // 创建一份 fake window
    const fakeWindow = Object.create(null) as Window;

    /**
     * 设置属性 p 的值为 value originValue
     * 首先，每次的值 会通过 currentUpdatedPropsValueMap 进行更新
     * 如果 sync2Window 为 true 那么就会 同步更新到 globalContext 里面
     * 如果 globalContext 没有，那么就会 addedPropsMapInSandbox 添加 value
     * 如果 modifiedPropsOriginalValueMapInSandbox 没有，那么就会添加 originalValue
     * 
     * 
     * if window no has p，那么属于新增变量
     * else if 不属于更新的变量，那么记录原始数据
     * 然后更新数据
     * 
     * 这种沙箱应该是类似于 将 新增的变量记录下来
     * 将如果存在的属性修改，就会记录原始数据
     * 在移除的时候，可以直接删除新增的变量，然后将原始数据覆盖新数据
     * 做到恢复的效果
     * @param p 
     * @param value 
     * @param originalValue 
     * @param sync2Window 
     * @returns true
     */
    const setTrap = (p: PropertyKey, value: any, originalValue: any, sync2Window = true) => {
      // 如果属于激活状态
      if (this.sandboxRunning) {
        if (!rawWindow.hasOwnProperty(p)) {
          addedPropsMapInSandbox.set(p, value);
        } else if (!modifiedPropsOriginalValueMapInSandbox.has(p)) {
          // 如果当前 window 对象存在该属性，且 record map 中未记录过，则记录该属性初始值
          modifiedPropsOriginalValueMapInSandbox.set(p, originalValue);
        }

        currentUpdatedPropsValueMap.set(p, value);

        if (sync2Window) {
          // 必须重新设置 window 对象保证下次 get 时能拿到已更新的数据
          (rawWindow as any)[p] = value;
        }

        this.latestSetProp = p;

        return true;
      }

      // 表示 sandbox 已经被 销毁 或者 inactive

      // 在 strict-mode 下，Proxy 的 handler.set 返回 false 会抛出 TypeError，在沙箱卸载的情况下应该忽略错误
      return true;
    };

    // 通过使用 Proxy 代理。
    const proxy = new Proxy(fakeWindow, {
      set: (_: Window, p: PropertyKey, value: any): boolean => {
        const originalValue = (rawWindow as any)[p];
        // 返回值必须为 true
        return setTrap(p, value, originalValue, true);
      },

      get(_: Window, p: PropertyKey): any {
        // 避免谁使用 window.window 还是 window.self 要逃离沙箱环境，触摸真正的 window 或使用 window.top 检查是否有iframe上下文
        // avoid who using window.window or window.self to escape the sandbox environment to touch the really window
        // or use window.top to check if an iframe context
        // see https://github.com/eligrey/FileSaver.js/blob/master/src/FileSaver.js#L13
        // 代表都是 window 本身
        if (p === 'top' || p === 'parent' || p === 'window' || p === 'self') {
          return proxy;
        }

        const value = (rawWindow as any)[p];
        return getTargetValue(rawWindow, value);
      },

      // trap in operator
      // see https://github.com/styled-components/styled-components/blob/master/packages/styled-components/src/constants.js#L12
      has(_: Window, p: string | number | symbol): boolean {
        return p in rawWindow;
      },

      /**
       * 获取属性描述
       * @param _ 
       * @param p 
       * @returns 
       */
      getOwnPropertyDescriptor(_: Window, p: PropertyKey): PropertyDescriptor | undefined {
        const descriptor = Object.getOwnPropertyDescriptor(rawWindow, p);
        // A property cannot be reported as non-configurable, if it does not exists as an own property of the target object
        // 如果属性不作为目标对象的自有属性存在，则不能将其报告为不可配置
        if (descriptor && !descriptor.configurable) {
          descriptor.configurable = true;
        }
        return descriptor;
      },

      /**
       * 这个更新属性 拦截对象的 Object.defineProperty() 操作。
       * Object.defineProperty 返回一个对象，或者如果属性没有被成功定义，抛出一个 TypeError。
       * 相比之下，Reflect.defineProperty 方法只返回一个 Boolean，来说明该属性是否被成功定义。
       * @param _ 
       * @param p 
       * @param attributes 
       * @returns 
       */
      defineProperty(_: Window, p: string | symbol, attributes: PropertyDescriptor): boolean {
        const originalValue = (rawWindow as any)[p];
        const done = Reflect.defineProperty(rawWindow, p, attributes);
        const value = (rawWindow as any)[p];
        setTrap(p, value, originalValue, false);

        return done;
      },
    });

    this.proxy = proxy;
  }

  patchDocument(): void {}
}
