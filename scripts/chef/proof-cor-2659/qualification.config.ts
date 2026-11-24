import configuration from './playwright.config.ts';

const root = process.env['RUNNER_TEMP'];
const lane = process.env['QUALIFICATION_LANE'];
if (!root || (lane !== 'success' && lane !== 'failure')) throw new Error('Missing qualification output');
export default { ...configuration, outputDir: `${root}/cor-2659/${lane}` };
