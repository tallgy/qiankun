/**
 * @author Saviio
 * @since 2020-4-19
 */

// https://developer.mozilla.org/en-US/docs/Web/API/CSSRule
enum RuleType {
  // type: rule will be rewrote
  STYLE = 1,
  MEDIA = 4,
  SUPPORTS = 12,

  // type: value will be kept
  IMPORT = 3,
  FONT_FACE = 5,
  PAGE = 6,
  KEYFRAMES = 7,
  KEYFRAME = 8,
}

const arrayify = <T>(list: CSSRuleList | any[]) => {
  return [].slice.call(list, 0) as T[];
};

const rawDocumentBodyAppend = HTMLBodyElement.prototype.appendChild;

export class ScopedCSS {
  private static ModifiedTag = 'Symbol(style-modified-qiankun)';

  private sheet: StyleSheet;

  private swapNode: HTMLStyleElement;

  constructor() {
    const styleNode = document.createElement('style');
    rawDocumentBodyAppend.call(document.body, styleNode);

    this.swapNode = styleNode;
    this.sheet = styleNode.sheet!;
    this.sheet.disabled = true;
  }

  /**
   * 这个主要是 依赖了 cssRule 来让 textContent 层架 prefix 的scope
   * 增加了 css scope 效果
   * @param styleNode styleNode
   * @param prefix 同一个微应用的值相等
   * @returns 
   */
  process(styleNode: HTMLStyleElement, prefix: string = '') {
    // 判断是否已经更新了
    if (ScopedCSS.ModifiedTag in styleNode) {
      return;
    }

    // 如果存在 textContent 那么将里面的 rules 加上 scope 然后返回
    if (styleNode.textContent !== '') {
      // 其实就是 style 里面的内容
      const textNode = document.createTextNode(styleNode.textContent || '');
      this.swapNode.appendChild(textNode);
      // 详细请看 styleSheet https://developer.mozilla.org/zh-CN/docs/Web/API/StyleSheet
      const sheet = this.swapNode.sheet as any; // type is missing
      // 详情请看 https://developer.mozilla.org/zh-CN/docs/Web/API/CSSRule
      const rules = arrayify<CSSRule>(sheet?.cssRules ?? []);
      const css = this.rewrite(rules, prefix);
      // eslint-disable-next-line no-param-reassign
      // 覆盖原来的 textContent 可以生效
      styleNode.textContent = css;

      // cleanup
      this.swapNode.removeChild(textNode);
      (styleNode as any)[ScopedCSS.ModifiedTag] = true;
      return;
    }

    // 本质实现还是和上面一样的，添加监听的原因应该是如果此时内容没有更新，那么去监听
    // 等待更新后进行操作
    // MutationObserver 接口提供了监视对 DOM 树所做更改的能力。
    const mutator = new MutationObserver((mutations) => {
      for (let i = 0; i < mutations.length; i += 1) {
        const mutation = mutations[i];

        if (ScopedCSS.ModifiedTag in styleNode) {
          return;
        }

        if (mutation.type === 'childList') {
          const sheet = styleNode.sheet as any;
          const rules = arrayify<CSSRule>(sheet?.cssRules ?? []);
          const css = this.rewrite(rules, prefix);

          // eslint-disable-next-line no-param-reassign
          styleNode.textContent = css;
          // eslint-disable-next-line no-param-reassign
          (styleNode as any)[ScopedCSS.ModifiedTag] = true;
        }
      }
    });

    // since observer will be deleted when node be removed
    // we dont need create a cleanup function manually
    // 因为当节点被移除时观察者也会被删除，所以我们不需要手动创建一个清理函数
    // see https://developer.mozilla.org/en-US/docs/Web/API/MutationObserver/disconnect
    mutator.observe(styleNode, { childList: true });
  }

  /**
   * 这个作用是将 css rule 重写，将每一个 css rules 都添加一个 prefix 的作用域
   * @param rules 
   * @param prefix 
   * @returns 
   */
  private rewrite(rules: CSSRule[], prefix: string = '') {
    let css = '';

    // 判断每个 cssRule type 是什么类型
    // https://developer.mozilla.org/en-US/docs/Web/API/CSSRule/type
    rules.forEach((rule) => {
      switch (rule.type) {
        case RuleType.STYLE:
          css += this.ruleStyle(rule as CSSStyleRule, prefix);
          break;
        case RuleType.MEDIA:
          css += this.ruleMedia(rule as CSSMediaRule, prefix);
          break;
        case RuleType.SUPPORTS:
          css += this.ruleSupport(rule as CSSSupportsRule, prefix);
          break;
        default:
          if (typeof rule.cssText === 'string') {
            css += `${rule.cssText}`;
          }

          break;
      }
    });

    return css;
  }

  // handle case:
  // .app-main {}
  // html, body {}

  // eslint-disable-next-line class-methods-use-this
  private ruleStyle(rule: CSSStyleRule, prefix: string) {
    const rootSelectorRE = /((?:[^\w\-.#]|^)(body|html|:root))/gm;
    const rootCombinationRE = /(html[^\w{[]+)/gm;

    const selector = rule.selectorText.trim();

    let cssText = '';
    if (typeof rule.cssText === 'string') {
      cssText = rule.cssText;
    }

    // handle html { ... }
    // handle body { ... }
    // handle :root { ... }
    if (selector === 'html' || selector === 'body' || selector === ':root') {
      return cssText.replace(rootSelectorRE, prefix);
    }

    // handle html body { ... }
    // handle html > body { ... }
    if (rootCombinationRE.test(rule.selectorText)) {
      const siblingSelectorRE = /(html[^\w{]+)(\+|~)/gm;

      // since html + body is a non-standard rule for html
      // transformer will ignore it
      if (!siblingSelectorRE.test(rule.selectorText)) {
        cssText = cssText.replace(rootCombinationRE, '');
      }
    }

    // handle grouping selector, a,span,p,div { ... }
    cssText = cssText.replace(/^[\s\S]+{/, (selectors) =>
      selectors.replace(/(^|,\n?)([^,]+)/g, (item, p, s) => {
        // handle div,body,span { ... }
        if (rootSelectorRE.test(item)) {
          return item.replace(rootSelectorRE, (m) => {
            // do not discard valid previous character, such as body,html or *:not(:root)
            const whitePrevChars = [',', '('];

            if (m && whitePrevChars.includes(m[0])) {
              return `${m[0]}${prefix}`;
            }

            // replace root selector with prefix
            return prefix;
          });
        }

        return `${p}${prefix} ${s.replace(/^ */, '')}`;
      }),
    );

    return cssText;
  }

  // handle case:
  // @media screen and (max-width: 300px) {}
  private ruleMedia(rule: CSSMediaRule, prefix: string) {
    const css = this.rewrite(arrayify(rule.cssRules), prefix);
    return `@media ${rule.conditionText || rule.media.mediaText} {${css}}`;
  }

  // handle case:
  // @supports (display: grid) {}
  private ruleSupport(rule: CSSSupportsRule, prefix: string) {
    const css = this.rewrite(arrayify(rule.cssRules), prefix);
    return `@supports ${rule.conditionText || rule.cssText.split('{')[0]} {${css}}`;
  }
}

let processor: ScopedCSS;

export const QiankunCSSRewriteAttr = 'data-qiankun';
/**
 * css 增加 scope 
 * @param appWrapper template
 * @param stylesheetElement style
 * @param appName 
 * @returns 
 */
export const process = (
  appWrapper: HTMLElement,
  stylesheetElement: HTMLStyleElement | HTMLLinkElement,
  appName: string,
): void => {
  // lazy singleton pattern
  if (!processor) {
    processor = new ScopedCSS();
  }

  if (stylesheetElement.tagName === 'LINK') {
    // 特点:沙箱。experimentalStyleIsolation不支持链接元素。
    console.warn('Feature: sandbox.experimentalStyleIsolation is not support for link element yet.');
  }

  const mountDOM = appWrapper;
  if (!mountDOM) {
    return;
  }

  const tag = (mountDOM.tagName || '').toLowerCase();

  // 如果是 style
  if (tag && stylesheetElement.tagName === 'STYLE') {
    // 生成 prefix 按理来说，一个 微应用的 prefix 是相等的。
    // 这个作用就是生成 css 的一个scope tag=div QiankunCSSRewriteAttr=data-qiankun appName
    const prefix = `${tag}[${QiankunCSSRewriteAttr}="${appName}"]`;
    processor.process(stylesheetElement, prefix);
  }
};
