/** The schema-policy field of `EngineOptions`. */
export interface EngineSchemaPolicyOptions {
  /**
   * Whether every registered definition must declare its schemas. Under the
   * default `'optional'`, schemas are metadata a definition may omit, and an
   * omitted one leaves that field empty in the contract, `GET /v1/registry`,
   * `weft codegen` output, and MCP tools. Under `'required'`, registration
   * throws {@link DefinitionSchemaRequiredError}, naming every undeclared
   * schema, when a definition leaves one out. That covers a workflow's input
   * and output, its finalizer's, each declared signal's input, each update's
   * and query's input and output, each `.activities({...})` entry's input and
   * output, and each engine-level activity's input and output, whether passed
   * to `engine.register()`, `Engine.create({ workflows, activities })`, or
   * loaded by `engine.resolveWorkflowSource()`.
   *
   * There is no exemption for a payload-less message or activity: at runtime
   * the engine cannot tell one from a definition whose author forgot the
   * schema, so declare a schema that accepts `undefined`, such as
   * `z.undefined()`. The check never validates payloads at runtime. A dynamic
   * source revision another process already installed is read from the catalog
   * without loading its module, so this process checks it only when it loads
   * that module to run it.
   */
  schemas?: 'optional' | 'required';
}
