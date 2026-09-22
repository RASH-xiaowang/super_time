/**
 * 协议枚举与继承链的关系 —— M21「把 `gateway.ts` 的方法面拆成 mixin 链」的前提。
 *
 * `@Remote` 的标记写在**实例原型的直接原型**上（`Object.getPrototypeOf(this)`），
 * 而 `remoteMethods(service)` 只读叶子原型自己的属性、**不沿链查找**。
 * 装饰器的 `addInitializer` 在构造期以「最派生的实例」为 `this` 运行，所以基类方法上的
 * `@Remote` 会落到叶子原型 —— 继承式拆分因此可行。这条前提是隐式的：一旦上游改成
 * 「只登记本类声明的方法」或「own-property 语义变化」，拆分就会**静默丢接口**
 * （界面上表现为一批方法突然 `not found`）。故固化成用例。
 */
import { Remote, remoteMethods } from '@deepseek-ai/dsh-typert-protocol'
import { describe, expect, it } from 'vitest'

class RemoteBase {
  @Remote('baseAlpha')
  baseAlpha(): string { return 'alpha' }

  @Remote('baseBeta')
  baseBeta(): string { return 'beta' }
}

class RemoteLeaf extends RemoteBase {
  @Remote('leafGamma')
  leafGamma(): string { return 'gamma' }
}

describe('@Remote：方法面枚举与继承链', () => {
  it('基类声明的 @Remote 方法出现在叶子实例的方法面里（mixin 链拆分的前提）', () => {
    expect(remoteMethods(new RemoteLeaf()).map((m) => m.method)).toEqual(['baseAlpha', 'baseBeta', 'leafGamma'])
  })

  it('标记集是**叶子原型自己的属性**（方法仍留在声明它的基类原型上）', () => {
    const leafProto = Object.getPrototypeOf(new RemoteLeaf())
    const marker = Object.getOwnPropertyDescriptor(leafProto, '@deepseek-ai/dsh-typert-protocol/remote-methods')
    expect(marker, '标记没落在最派生原型上 —— 继承式拆分会静默丢接口').toBeDefined()
    expect(Object.getOwnPropertyDescriptor(RemoteBase.prototype, '@deepseek-ai/dsh-typert-protocol/remote-methods')?.value)
      .toBeUndefined()
    expect(Object.getOwnPropertyDescriptor(RemoteBase.prototype, 'baseAlpha')).toBeDefined()
    expect(new RemoteLeaf().baseAlpha(), '方法要能经继承链调用').toBe('alpha')
  })
})
