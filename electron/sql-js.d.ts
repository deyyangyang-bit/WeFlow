// sql.js 无官方类型声明；运行时由 vite/esbuild 解析，类型检查以 any 兜底。
// 仅消除 tsconfig.node 对 salesDbService 的 TS7016 / TS2709。
// 注：必须显式 export type Database（shorthand `declare module 'sql.js'` 会让
// 命名类型导入被当作 namespace，触发 TS2709 "Cannot use namespace as a type"）。
declare module 'sql.js' {
  export type Database = any
  const initSqlJs: any
  export default initSqlJs
}
