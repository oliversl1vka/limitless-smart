import * as vscode from "vscode";
import * as fs from "fs";
import * as path from "path";

const PATCH_MARKER = "/* __SMART_ROUTER_PATCHED__ */";

/**
 * Ensures the GitHub Copilot Chat extension is patched to display
 * Smart Router in the model picker and route requests through it.
 *
 * Returns true if already patched or newly patched (reload needed).
 * Returns false if patching failed.
 */
export async function ensureCopilotPatched(
  log: vscode.LogOutputChannel,
): Promise<"already-patched" | "patched" | "failed"> {
  const copilotExt = vscode.extensions.getExtension("github.copilot-chat");
  if (!copilotExt) {
    log.warn("Copilot Chat extension not found — cannot patch");
    return "failed";
  }

  const extPath = copilotExt.extensionPath;
  const extensionJs = path.join(extPath, "dist", "extension.js");

  if (!fs.existsSync(extensionJs)) {
    log.warn("Copilot Chat extension.js not found at: " + extensionJs);
    return "failed";
  }

  const backupPath = extensionJs + ".smartrouter-backup";
  let content = fs.readFileSync(extensionJs, "utf-8");

  if (content.includes(PATCH_MARKER)) {
    const patchLooksComplete =
      content.includes("globalThis.__sr_ep") &&
      content.includes('id:"smart-router-auto"');
    if (patchLooksComplete) {
      log.info("Copilot Chat already patched for Smart Router");
      return "already-patched";
    }

    if (!fs.existsSync(backupPath)) {
      log.error("Patch marker found but patch is incomplete and no backup is available");
      return "failed";
    }

    log.warn("Patch marker found but patch is incomplete — restoring backup and retrying");
    fs.copyFileSync(backupPath, extensionJs);
    content = fs.readFileSync(extensionJs, "utf-8");
  }

  // --- Extract minified variable/class names ---
  const names = extractMinifiedNames(content);
  if (!names) {
    log.error(
      "Could not find patch anchor patterns in Copilot Chat bundle. " +
        "The extension version may have changed its internal structure.",
    );
    return "failed";
  }

  log.info(
    `Patch targets: arrayVar=${names.arrayVar}, endpointsVar=${names.endpointsVar}, ` +
      `wrapperClass=${names.wrapperClass}, modelVar=${names.endpointModelVar}`,
  );

  // --- Back up original ---
  if (!fs.existsSync(backupPath)) {
    fs.copyFileSync(extensionJs, backupPath);
    log.info("Created backup: " + backupPath);
  }

  const modelListPatched = applyModelListPatch(content, names, log);
  if (!modelListPatched) {
    log.error("Patch aborted before write: model list injection failed");
    return "failed";
  }

  const endpointPatched = applyEndpointPatch(modelListPatched, names, log);
  if (!endpointPatched) {
    log.error("Patch aborted before write: endpoint injection failed");
    return "failed";
  }

  if (!endpointPatched.includes(PATCH_MARKER) || !endpointPatched.includes("globalThis.__sr_ep")) {
    log.error("Patch verification failed before write");
    return "failed";
  }

  fs.writeFileSync(extensionJs, endpointPatched, "utf-8");
  log.info("Copilot Chat patched successfully for Smart Router");
  return "patched";
}

/**
 * Restore the original Copilot Chat extension.js from backup.
 */
export function restoreCopilotBackup(log: vscode.LogOutputChannel): boolean {
  const copilotExt = vscode.extensions.getExtension("github.copilot-chat");
  if (!copilotExt) return false;

  const extensionJs = path.join(copilotExt.extensionPath, "dist", "extension.js");
  const backupPath = extensionJs + ".smartrouter-backup";

  if (!fs.existsSync(backupPath)) {
    log.warn("No backup found to restore");
    return false;
  }

  fs.copyFileSync(backupPath, extensionJs);
  log.info("Restored original Copilot Chat extension.js from backup");
  return true;
}

// ── Internal helpers ─────────────────────────────────────────────────

interface PatchNames {
  /** Variable name for the model info array (e.g. "a") */
  arrayVar: string;
  /** Variable name for the chat endpoints array (e.g. "c") */
  endpointsVar: string;
  /** Class name for the extension-contributed model wrapper (e.g. "eN") */
  wrapperClass: string;
  /** The full return statement to inject before */
  returnStatement: string;
  /**
   * The getChatEndpoint target: the unique snippet where the endpoint
   * provider resolves Copilot-vendor models via the model fetcher.
   * We inject a Smart Router intercept before this line.
   */
  endpointResolveSnippet: string;
  /** Variable used for the model reference in getChatEndpoint (e.g. "r") */
  endpointModelVar: string;
}

function extractMinifiedNames(content: string): PatchNames | null {
  // 1. Find: return this._currentModels=X,this._chatEndpoints=Y,X
  const returnMatch = content.match(
    /return this\._currentModels=(\w+),this\._chatEndpoints=(\w+),\1/,
  );
  if (!returnMatch) return null;

  // 2. Find the wrapper class: var XX=class{constructor(...){...isExtensionContributed=!0
  const wrapperMatch = content.match(
    /var\s+(\w+)=class\{constructor\([^)]*\)\{[^}]{0,500}isExtensionContributed=!0/,
  );
  if (!wrapperMatch) return null;

  // 3. Find the endpoint resolution in getChatEndpoint:
  //    let VAR=await this._modelFetcher.getChatModelFromApiModel(VAR2);
  //    return VAR?this.getOrCreateChatEndpointInstance(VAR):this.getChatEndpoint
  const endpointMatch = content.match(
    /let (\w+)=await this\._modelFetcher\.getChatModelFromApiModel\((\w+)\);return \1\?this\.getOrCreateChatEndpointInstance\(\1\):this\.getChatEndpoint/,
  );
  if (!endpointMatch) return null;

  return {
    arrayVar: returnMatch[1],
    endpointsVar: returnMatch[2],
    wrapperClass: wrapperMatch[1],
    returnStatement: returnMatch[0],
    endpointResolveSnippet: endpointMatch[0],
    endpointModelVar: endpointMatch[2],
  };
}

/**
 * Patch 1: Inject Smart Router model into the Copilot model info list.
 */
function applyModelListPatch(
  content: string,
  names: PatchNames,
  log: vscode.LogOutputChannel,
): string | undefined {
  // Static model info + mock LM object to avoid selectChatModels loop.
  // selectChatModels inside _provideLanguageModelChatInfo triggers
  // provideLanguageModelChatInformation which updates the registry which
  // triggers Copilot to rebuild → infinite loop. Instead, push static
  // info and create a mock that lazily resolves the real model at request time.
  const injection = [
    PATCH_MARKER,
    `try{`,
    `${names.arrayVar}.push({`,
    `id:"smart-router-auto",`,
    `name:"Smart Router",`,
    `family:"smart-router",`,
    `tooltip:"Auto-selects the best Copilot model for your prompt complexity",`,
    `detail:"Routes simple\\u2192fast, complex\\u2192powerful",`,
    `version:"1.0.0",`,
    `maxInputTokens:1000000,`,
    `maxOutputTokens:128000,`,
    `isUserSelectable:true,`,
    `isDefault:false,`,
    `multiplier:"1x",`,
    `multiplierNumeric:1,`,
    `capabilities:{imageInput:true,toolCalling:true},`,
    `category:{label:"Smart Router",order:-1}`,
    `});`,
    // Mock LM: has the same shape eN's constructor reads, but sendRequest
    // lazily discovers the real Smart Router model at request time only.
    `var _srMock={`,
    `id:"smart-router-auto",name:"Smart Router",vendor:"smart",`,
    `family:"smart-router",version:"1.0.0",maxInputTokens:1000000,`,
    `capabilities:{supportsToolCalling:true,supportsImageToText:true},`,
    `countTokens:async function(t,c){return Math.ceil((typeof t==="string"?t:"").length/4)},`,
    `sendRequest:async function(m,o,c){`,
    `var _v=require("vscode");`,
    `var _ms=await _v.lm.selectChatModels({vendor:"smart"});`,
    `if(_ms.length>0)return _ms[0].sendRequest(m,o,c);`,
    `throw new Error("Smart Router model not available")}};`,
    `${names.endpointsVar}.push(this._instantiationService.createInstance(${names.wrapperClass},_srMock));`,
    `}catch(_srErr){}`,
  ].join("");

  const target = names.returnStatement;
  if (!content.includes(target)) {
    log.error("Patch 1: return statement not found");
    return undefined;
  }

  const result = content.replace(target, injection + target);
  if (result === content) {
    log.error("Patch 1: replacement produced no changes");
    return undefined;
  }
  log.info("Patch 1 applied: Smart Router injected into model list");
  return result;
}

/**
 * Patch 2: Intercept Smart Router in the base getChatEndpoint method.
 *
 * When a model with vendor="copilot" and id="smart-router-auto" is resolved,
 * the model fetcher won't find it (it's not a real Copilot API model).
 * We inject a check BEFORE the fetcher call that discovers the real Smart Router
 * model via selectChatModels and wraps it with eN.
 */
function applyEndpointPatch(
  content: string,
  names: PatchNames,
  log: vscode.LogOutputChannel,
): string | undefined {
  const v = names.endpointModelVar;
  const cls = names.wrapperClass;
  // Cache the endpoint in globalThis so selectChatModels only runs once.
  // The eN instance wraps our LanguageModelChat and is stateless per-request.
  const injection = [
    `if(${v}&&${v}.id==="smart-router-auto"){`,
    `try{`,
    `if(!globalThis.__sr_ep){`,
    `let _v=require("vscode");`,
    `let _ms=await _v.lm.selectChatModels({vendor:"smart"});`,
    `if(_ms.length>0)globalThis.__sr_ep=this._instantiationService.createInstance(${cls},_ms[0]);`,
    `}`,
    `if(globalThis.__sr_ep)return globalThis.__sr_ep;`,
    `}catch(_srErr2){}`,
    `}`,
  ].join("");

  const target = names.endpointResolveSnippet;
  if (!content.includes(target)) {
    log.error("Patch 2: getChatEndpoint resolve snippet not found");
    return undefined;
  }

  const result = content.replace(target, injection + target);
  if (result === content) {
    log.error("Patch 2: replacement produced no changes");
    return undefined;
  }
  log.info("Patch 2 applied: Smart Router intercept in getChatEndpoint");
  return result;
}
