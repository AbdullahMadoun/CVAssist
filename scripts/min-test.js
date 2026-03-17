require('dotenv').config();

const { callOpenAIText } = require('../server/openai-client');

const apiKey = process.env.OPENROUTER_API_KEY || '';
const model = process.env.OPENROUTER_MODEL || 'deepseek/deepseek-v3.2';

async function main() {
  if (!apiKey) {
    console.log('Skipped: OPENROUTER_API_KEY is not configured.');
    process.exit(0);
  }

  const result = await callOpenAIText(
    apiKey,
    'You are a concise assistant.',
    'Return exactly: 2',
    { model, maxTokens: 20, temperature: 0 }
  );

  console.log(JSON.stringify({
    model: result.requestMeta?.model || model,
    output: result.data,
    usage: result.usage || {},
  }, null, 2));
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
