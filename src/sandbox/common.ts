/**
 * @author Kuitos
 * @since 2020-04-13
 */

import { isBoundedFunction, isCallable, isConstructable } from '../utils';

type AppInstance = { name: string; window: WindowProxy };
let currentRunningApp: AppInstance | null = null;

/**
 * get the app that running tasks at current tick
 * 获取当前运行任务的应用程序
 */
export function getCurrentRunningApp() {
  return currentRunningApp;
}

export function setCurrentRunningApp(appInstance: { name: string; window: WindowProxy }) {
  // Set currentRunningApp and it's proxySandbox to global window, as its only use case is for document.createElement from now on, which hijacked by a global way
  currentRunningApp = appInstance;
}

export function clearCurrentRunningApp() {
  currentRunningApp = null;
}

const functionBoundedValueMap = new WeakMap<CallableFunction, CallableFunction>();

/**
 * 简单的就是获取 value
 * 考虑了方法的情况，这个不是很了解
 * @param target 
 * @param value 
 * @returns 
 */
export function getTargetValue(target: any, value: any): any {
  /*
    仅绑定 isCallable && !isBoundedFunction && !isConstructable 的函数对象，如 window.console、window.atob 这类，不然微应用中调用时会抛出 Illegal invocation 异常
    目前没有完美的检测方式，这里通过 prototype 中是否还有可枚举的拓展方法的方式来判断
    @warning 这里不要随意替换成别的判断方式，因为可能触发一些 edge case（比如在 lodash.isFunction 在 iframe 上下文中可能由于调用了 top window 对象触发的安全异常）
   */
  // 如果 是方法 且 没有使用 bind 不是构造函数
  if (isCallable(value) && !isBoundedFunction(value) && !isConstructable(value)) {
    const cachedBoundFunction = functionBoundedValueMap.get(value);
    if (cachedBoundFunction) {
      return cachedBoundFunction;
    }

    const boundValue = Function.prototype.bind.call(value, target);

    // some callable function has custom fields, we need to copy the enumerable props to boundValue. such as moment function.
    // use for..in rather than Object.keys.forEach for performance reason
    // 一些可调用函数有自定义字段，我们需要将可枚举的props复制到boundValue。比如矩函数。出于性能原因，使用for. in而不是Object.keys.forEach
    // eslint-disable-next-line guard-for-in,no-restricted-syntax
    for (const key in value) {
      boundValue[key] = value[key];
    }

    // copy prototype if bound function not have but target one have
    // as prototype is non-enumerable mostly, we need to copy it from target function manually
    // 如果绑定函数没有原型，而目标函数有原型，因为原型大多是不可枚举的，我们需要手动从目标函数复制它
    if (value.hasOwnProperty('prototype') && !boundValue.hasOwnProperty('prototype')) {
      // we should not use assignment operator to set boundValue prototype like `boundValue.prototype = value.prototype`
      // as the assignment will also look up prototype chain while it hasn't own prototype property,
      // when the lookup succeed, the assignment will throw an TypeError like `Cannot assign to read only property 'prototype' of function` if its descriptor configured with writable false or just have a getter accessor
      // see https://github.com/umijs/qiankun/issues/1121
      // 我们不应该使用赋值操作符来设置像' boundValue '这样的boundValue原型。
      // 原型=价值。prototype'作为赋值也将查找原型链，而它没有自己的prototype属性，
      // 当查找成功时，赋值将抛出TypeError，如' Cannot assign to read - only property
      //  'prototype' of function '，如果它的描述符配置为可写的false或只有getter访问器
      Object.defineProperty(boundValue, 'prototype', { value: value.prototype, enumerable: false, writable: true });
    }

    // Some util, like `function isNative() {  return typeof Ctor === 'function' && /native code/.test(Ctor.toString()) }` relies on the original `toString()` result
    // but bound functions will always return "function() {[native code]}" for `toString`, which is misleading
    // 一些util，如'function isNative(){返回类型的Ctor === = 'function' && /native code/.test(Ctor.toString())} 
    // '依赖于原始的' toString() '结果，但绑定函数总是会为' toString '返回'function () {[native code]}"，这是误导
    if (typeof value.toString === 'function') {
      const valueHasInstanceToString = value.hasOwnProperty('toString') && !boundValue.hasOwnProperty('toString');
      const boundValueHasPrototypeToString = boundValue.toString === Function.prototype.toString;

      if (valueHasInstanceToString || boundValueHasPrototypeToString) {
        const originToStringDescriptor = Object.getOwnPropertyDescriptor(
          valueHasInstanceToString ? value : Function.prototype,
          'toString',
        );

        Object.defineProperty(boundValue, 'toString', {
          ...originToStringDescriptor,
          ...(originToStringDescriptor?.get ? null : { value: () => value.toString() }),
        });
      }
    }

    functionBoundedValueMap.set(value, boundValue);
    return boundValue;
  }

  return value;
}
