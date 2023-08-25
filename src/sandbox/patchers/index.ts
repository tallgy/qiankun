/**
 * @author Kuitos
 * @since 2019-04-11
 */

import type { Freer, SandBox } from '../../interfaces';
import { SandBoxType } from '../../interfaces';
import * as css from './css';
import { patchLooseSandbox, patchStrictSandbox } from './dynamicAppend';
import patchHistoryListener from './historyListener';
import patchInterval from './interval';
import patchWindowListener from './windowListener';

/**
 * 用于DOM操作的补丁 方便在添加 DOM 的时候 添加 js隔离 和 css隔离
 * 和 patchAtBootstrapping
 * @param appName 
 * @param elementGetter 
 * @param sandbox 
 * @param scopedCSS 
 * @param excludeAssetFilter 
 * @param speedySandBox 
 * @returns 
 */
export function patchAtMounting(
  appName: string,
  elementGetter: () => HTMLElement | ShadowRoot,
  sandbox: SandBox,
  scopedCSS: boolean,
  excludeAssetFilter?: CallableFunction,
  speedySandBox?: boolean,
): Freer[] {
  const basePatchers = [
    () => patchInterval(sandbox.proxy),
    () => patchWindowListener(sandbox.proxy),
    () => patchHistoryListener(),
  ];

  const patchersInSandbox = {
    [SandBoxType.LegacyProxy]: [
      ...basePatchers,
      () => patchLooseSandbox(appName, elementGetter, sandbox, true, scopedCSS, excludeAssetFilter),
    ],
    [SandBoxType.Proxy]: [
      ...basePatchers,
      () => patchStrictSandbox(appName, elementGetter, sandbox, true, scopedCSS, excludeAssetFilter, speedySandBox),
    ],
    [SandBoxType.Snapshot]: [
      ...basePatchers,
      () => patchLooseSandbox(appName, elementGetter, sandbox, true, scopedCSS, excludeAssetFilter),
    ],
  };

  return patchersInSandbox[sandbox.type]?.map((patch) => patch());
}

/**
 * 用于DOM操作的补丁 方便在添加 DOM 的时候 添加 js隔离 和 css隔离
 * @param appName 
 * @param elementGetter 
 * @param sandbox 
 * @param scopedCSS 
 * @param excludeAssetFilter 
 * @param speedySandBox 
 * @returns 
 */
export function patchAtBootstrapping(
  appName: string,
  elementGetter: () => HTMLElement | ShadowRoot,
  sandbox: SandBox,
  scopedCSS: boolean,
  excludeAssetFilter?: CallableFunction,
  speedySandBox?: boolean,
): Freer[] {
  // 这里的作用是为后续新增的DOM打补丁，便于触发 js隔离 和 css 隔离
  const patchersInSandbox = {
    [SandBoxType.LegacyProxy]: [
      () => patchLooseSandbox(appName, elementGetter, sandbox, false, scopedCSS, excludeAssetFilter),
    ],
    [SandBoxType.Proxy]: [
      () => patchStrictSandbox(appName, elementGetter, sandbox, false, scopedCSS, excludeAssetFilter, speedySandBox),
    ],
    [SandBoxType.Snapshot]: [
      () => patchLooseSandbox(appName, elementGetter, sandbox, false, scopedCSS, excludeAssetFilter),
    ],
  };

  return patchersInSandbox[sandbox.type]?.map((patch) => patch());
}

export { css };
