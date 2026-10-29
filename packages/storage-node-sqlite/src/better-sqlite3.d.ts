// `better-sqlite3` ships no types. This declares only the constructor surface NodeSQLiteStorage uses,
// the same structural types node-sqlite-loader.ts defines.
declare module 'better-sqlite3' {
  const Database: import('./node-sqlite-loader.ts').BetterSqliteConstructor;
  export default Database;
}
