/**
 * @author Kuitos
 * @since 2020-10-13
 */

import { checkActivityFunctions } from 'single-spa';
import type { Freer, SandBox } from '../../../interfaces';
import {
  calcAppCount,
  isAllAppsUnmounted,
  patchHTMLDynamicAppendPrototypeFunctions,
  rebuildCSSRules,
  recordStyledComponentsCSSRules,
} from './common';

/**
 * 只要劫持动态头部追加，就可以避免意外劫持除头部以外的元素的插入。
 * Just hijack dynamic head append, that could avoid accidentally hijacking the insertion of elements except in head.
 * Such a case: ReactDOM.createPortal(<style>.test{color:blue}</style>, container),
 * this could make we append the style element into app wrapper but it will cause an error while the react portal unmounting, as ReactDOM could not find the style in body children list.
 * 这样的情况: ReactDOM.createportal(<style>.test{color:blue}</style>, container)，
 * 这可以使我们将style元素附加到应用程序包装中，但它会在react门户卸载时导致错误，因为ReactDOM无法在body子列表中找到样式。
 * 
 * @param appName
 * @param appWrapperGetter
 * @param sandbox
 * @param mounting
 * @param scopedCSS
 * @param excludeAssetFilter
 */
export function patchLooseSandbox(
  appName: string,
  appWrapperGetter: () => HTMLElement | ShadowRoot,
  sandbox: SandBox,
  mounting = true,
  scopedCSS = false,
  excludeAssetFilter?: CallableFunction,
): Freer {
  const { proxy } = sandbox;

  let dynamicStyleSheetElements: Array<HTMLLinkElement | HTMLStyleElement> = [];

  const unpatchDynamicAppendPrototypeFunctions = patchHTMLDynamicAppendPrototypeFunctions(
    /*
      check if the currently specified application is active
      While we switch page from qiankun app to a normal react routing page, the normal one may load stylesheet dynamically while page rendering,
      but the url change listener must wait until the current call stack is flushed.
      This scenario may cause we record the stylesheet from react routing page dynamic injection,
      and remove them after the url change triggered and qiankun app is unmounting
      see https://github.com/ReactTraining/history/blob/master/modules/createHashHistory.js#L222-L230

      当我们将页面从乾坤app切换到正常的react路由页面时，
      正常的页面可以在页面呈现时动态加载样式表，
      但url更改侦听器必须等到当前调用堆栈被刷新。
      这种情况可能会导致我们从react路由页面动态注入中记录样式表，
      并在url更改触发和乾坤应用卸载后删除它们
     */
    () => checkActivityFunctions(window.location).some((name) => name === appName),
    () => ({
      appName,
      appWrapperGetter,
      proxy,
      strictGlobal: false,
      speedySandbox: false,
      scopedCSS,
      dynamicStyleSheetElements,
      excludeAssetFilter,
    }),
  );

  if (!mounting) calcAppCount(appName, 'increase', 'bootstrapping');
  if (mounting) calcAppCount(appName, 'increase', 'mounting');

  return function free() {
    if (!mounting) calcAppCount(appName, 'decrease', 'bootstrapping');
    if (mounting) calcAppCount(appName, 'decrease', 'mounting');

    // release the overwrite prototype after all the micro apps unmounted
    // 在所有微应用卸载后释放覆盖原型
    if (isAllAppsUnmounted()) unpatchDynamicAppendPrototypeFunctions();

    recordStyledComponentsCSSRules(dynamicStyleSheetElements);

    // As now the sub app content all wrapped with a special id container,
    // the dynamic style sheet would be removed automatically while unmounting
    // 现在，子应用程序的内容都用一个特殊的id容器包装，动态样式表将在卸载时自动删除

    return function rebuild() {
      rebuildCSSRules(dynamicStyleSheetElements, (stylesheetElement) => {
        const appWrapper = appWrapperGetter();
        if (!appWrapper.contains(stylesheetElement)) {
          // Using document.head.appendChild ensures that appendChild invocation can also directly use the HTMLHeadElement.prototype.appendChild method which is overwritten at mounting phase
          document.head.appendChild.call(appWrapper, stylesheetElement);
          return true;
        }

        return false;
      });

      // As the patcher will be invoked every mounting phase, we could release the cache for gc after rebuilding
      // 由于补丁程序将在每个挂载阶段调用，因此我们可以在重建后释放缓存以供gc使用
      if (mounting) {
        dynamicStyleSheetElements = [];
      }
    };
  };
}
