import { checkHumanInputSchema } from './human-input-schema.ts';
import { compileInterpretedSchema } from './schema-interpreter.ts';

const schema = checkHumanInputSchema('approval', {
  type: 'object',
  properties: { approved: { type: 'boolean' } },
  required: ['approved'],
  additionalProperties: false,
});
const validator = compileInterpretedSchema(schema);

export default {
  fetch(request: Request): Response {
    const accepted = validator.validate(
      new URL(request.url).pathname === '/accept' ? { approved: true } : {},
    );
    return Response.json({ accepted, errors: validator.errors.length });
  },
};
