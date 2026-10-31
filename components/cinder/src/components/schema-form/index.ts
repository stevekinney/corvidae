import './schema-form.css';

import SchemaForm from './schema-form.svelte';

export default SchemaForm;
export {
  readSchemaFormData,
  validateSchemaValue as validateSchemaFormValue,
} from './schema-form-validation.ts';
export type {
  SchemaFormDraftChangeHandler,
  SchemaFormOutput,
  SchemaFormProps,
  SchemaFormSchema,
  SchemaFormSubmitHandler,
} from './schema-form.types.ts';
export { SchemaForm };
