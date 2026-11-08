/** React 18.3+ 的 act 要求显式声明测试环境；统一在 vitest 启动前开启。 */
;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
