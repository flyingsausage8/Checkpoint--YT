let azureFunctionsApp = null;
try {
  ({ app: azureFunctionsApp } = require('@azure/functions'));
} catch (_) {
  azureFunctionsApp = null;
}

async function health() {
  return {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      ok: true,
      deployment: process.env.AZURE_OPENAI_DEPLOYMENT || 'questions',
      hasKey: Boolean(process.env.AZURE_OPENAI_API_KEY),
      hasEndpoint: Boolean(process.env.AZURE_OPENAI_ENDPOINT),
    }),
  };
}

if (azureFunctionsApp) {
  azureFunctionsApp.http('health', {
    route: 'health',
    methods: ['GET'],
    authLevel: 'anonymous',
    handler: health,
  });
}

module.exports = { health };
