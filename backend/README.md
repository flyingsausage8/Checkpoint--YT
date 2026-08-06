# FocusFlow Azure Functions Backend

This backend is the optional Phase 3 AI proxy for FocusFlow. The extension sends transcript chunks to your Azure Function. The Function validates the request, rate-limits it with the storage account the Function App already has, calls Azure OpenAI, validates the model output, and returns questions.

> The current extension build keeps AI off. Before enabling AI, add `"https://*.azurewebsites.net/*"` to `manifest.json` host permissions, reload the extension, and then use the popup's Azure Function URL setting.

## Deploy step by step

1. Create a free Azure account at https://azure.microsoft.com/free.
2. Install Node.js 20 from https://nodejs.org.
3. Install Azure Functions Core Tools:

   ```powershell
   npm i -g azure-functions-core-tools@4 --unsafe-perm true
   ```

4. Install the Azure CLI from https://learn.microsoft.com/cli/azure/install-azure-cli.
5. Sign in:

   ```powershell
   az login
   ```

6. Create a resource group:

   ```powershell
   az group create --name focusflow-rg --location eastus
   ```

7. Create an Azure OpenAI resource and deploy a model:
   - Open https://ai.azure.com.
   - Create or select an Azure OpenAI resource.
   - Deploy/select the `gpt-5-mini` model. The current live deployment uses model version `2025-08-07`, SKU `GlobalStandard`, capacity `50`.
   - Copy three values: the endpoint, an API key, and the deployment name. For the current deployment, the resource is `aoai-checkpoint-yt-pb5kh8`, endpoint is `https://aoai-checkpoint-yt-pb5kh8.openai.azure.com/`, and deployment name is `questions`.
   - Important: deployment name is not always the same as model name. Use the exact deployment name shown in Azure AI Foundry.

8. Create a Function App. Portal path:
   - Azure Portal -> Create a resource -> Function App.
   - Runtime stack: Node.js.
   - Version: 20.
   - Plan: Flex Consumption or Consumption.
   - Create a new storage account when prompted.

   Equivalent CLI example:

   ```powershell
   az storage account create --name focusflowstorage123 --resource-group focusflow-rg --location eastus --sku Standard_LRS
   az functionapp create --resource-group focusflow-rg --consumption-plan-location eastus --runtime node --runtime-version 20 --functions-version 4 --name focusflow-api-YOURNAME --storage-account focusflowstorage123
   ```

9. Set app settings. Replace every placeholder:

   ```powershell
   az functionapp config appsettings set --resource-group focusflow-rg --name func-checkpoint-yt-pb5kh8 --settings AZURE_OPENAI_ENDPOINT="https://aoai-checkpoint-yt-pb5kh8.openai.azure.com/" AZURE_OPENAI_API_KEY="YOUR_KEY" AZURE_OPENAI_DEPLOYMENT="questions" ALLOWED_ORIGINS="chrome-extension://YOUR_EXTENSION_ID"
   ```

10. Deploy from the `focusflow\backend` folder:

    ```powershell
    func azure functionapp publish func-checkpoint-yt-pb5kh8
    ```

11. Your function URL is:

    ```text
    https://func-checkpoint-yt-pb5kh8.azurewebsites.net/api/generate
    ```

12. Get your extension ID:
    - Open Chrome.
    - Go to `chrome://extensions`.
    - Turn on Developer mode.
    - Copy the ID under FocusFlow.

13. Update `ALLOWED_ORIGINS` with that ID and redeploy app settings if needed.
14. Paste the Function URL into the FocusFlow popup when you later enable AI.

## Redeploying after a code change

This app runs on the **Flex Consumption** SKU, which changes how it must be deployed. Use Azure Functions Core Tools, from the `backend` folder:

```powershell
func azure functionapp publish func-checkpoint-yt-pb5kh8 --build remote
```

`--build remote` matters: it makes Azure run `npm install`. There is no `node_modules` in this repo, and on some networks `registry.npmjs.org` is firewalled, so building locally is not always possible.

If `func` is not installed and npm is blocked, download the standalone build from GitHub releases (github.com is usually reachable when the npm registry is not):

```powershell
$rel = Invoke-RestMethod https://api.github.com/repos/Azure/azure-functions-core-tools/releases/latest -Headers @{'User-Agent'='x'}
$asset = $rel.assets | Where-Object { $_.name -match 'win-x64.*\.zip$' -and $_.name -notmatch 'symbols|sha' } | Select-Object -First 1
Invoke-WebRequest $asset.browser_download_url -OutFile "$env:TEMP\func-cli.zip"
Expand-Archive "$env:TEMP\func-cli.zip" -DestinationPath C:\src\yihan\func-cli -Force
```

### Ways of deploying that do not work here, and why

These all look reasonable and all fail on Flex Consumption. They are listed because one of them took the backend down.

| Command | What happens |
| --- | --- |
| `az functionapp deployment source config-zip --build-remote true` | Fails. `--build-remote` makes the CLI set `SCM_DO_BUILD_DURING_DEPLOYMENT` and `ENABLE_ORYX_BUILD`, and Flex Consumption rejects both. |
| `az webapp deploy --type zip` | Fails with HTTP 415; it does not send what the Flex publish endpoint expects. |
| `POST /api/publish?RemoteBuild=true` by hand | Rejected with the same app-settings complaint, even once those settings have been removed. |
| `POST /api/publish?RemoteBuild=false` by hand | **Succeeds and breaks the app.** It deploys exactly what is in the zip, so with no `node_modules` nothing can load, no functions register, and every endpoint returns 404. |

That last one is the dangerous one, because it reports success. If it happens, the fix is to publish again properly with Core Tools and `--build remote`; there is nothing to roll back to, because Flex keeps only the current package (`released-package.zip` in the deployment blob container) and has no persistent `/home/site` to recover a previous build from.

Check the app is healthy after any deploy:

```powershell
Invoke-RestMethod https://func-checkpoint-yt-pb5kh8.azurewebsites.net/api/health
```

`{"ok":true,...}` means the host loaded. A 404 means the deployment produced an app with no working functions.

## Cost warning

Set a budget alert or spending cap in Azure Cost Management before enabling AI. Code can reduce abuse, but Azure billing controls are the final protection against surprise costs.

## GPT-5 request note

The Azure OpenAI request is tuned for `gpt-5-mini`: it uses `max_completion_tokens`, sends no `temperature` or sampling parameters, keeps `response_format: { type: "json_object" }`, and uses API version `2025-01-01-preview`. The completion ceiling is 4000 because GPT-5 reasoning models can spend tokens internally before producing JSON.

The `/api/health` endpoint returns whether endpoint/key settings are present and which deployment name is active; it never reveals the key.

## Troubleshooting

| Symptom | Meaning | Fix |
| --- | --- | --- |
| 401 | Azure OpenAI rejected the key | Re-copy the key and update `AZURE_OPENAI_API_KEY`. |
| 403 `origin_rejected` | Extension origin is not allowed | Set `ALLOWED_ORIGINS=chrome-extension://YOUR_EXTENSION_ID`. |
| 404 from Azure OpenAI | Wrong deployment name or endpoint | Use deployment name `questions`; deployment name is not model name. |
| 429 | Rate limited | Wait and retry. This can be this proxy's per-IP limit or Azure OpenAI quota. |
| 400 `unsupported_parameter` | GPT-5 family request used an unsupported field | This backend uses `max_completion_tokens` and sends no temperature/top-p settings. Redeploy the latest code if you see this. |
| 500 `missing_azure_openai_config` | App settings are missing | Set endpoint, key, and deployment app settings. |
| 500 `server_error` | Unexpected backend failure | Check Function App logs. Transcript text is intentionally never logged. |
