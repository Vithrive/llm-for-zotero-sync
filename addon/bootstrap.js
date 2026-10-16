var chromeHandle;

function install() {}

async function startup({ id, version, resourceURI, rootURI }, reason) {
  await Zotero.initializationPromise;

  if (!rootURI) {
    rootURI = resourceURI.spec;
  }

  const aomStartup = Components.classes[
    "@mozilla.org/addons/addon-manager-startup;1"
  ].getService(Components.interfaces.amIAddonManagerStartup);
  const manifestURI = Services.io.newURI(rootURI + "manifest.json");
  chromeHandle = aomStartup.registerChrome(manifestURI, [
    ["content", "llm-for-zotero-sync", rootURI + "chrome/content/"],
  ]);

  const ctx = { rootURI };
  ctx._globalThis = ctx;

  Services.scriptloader.loadSubScript(
    rootURI + "chrome/content/scripts/llm-for-zotero-sync.js",
    ctx,
  );

  if (ctx.LlmForZoteroSync) {
    Zotero.LlmForZoteroSync = ctx.LlmForZoteroSync;
    await Zotero.LlmForZoteroSync.hooks.onStartup();
  }
}

async function onMainWindowLoad({ window }, reason) {
  if (Zotero.LlmForZoteroSync) {
    await Zotero.LlmForZoteroSync.hooks.onMainWindowLoad(window);
  }
}

async function onMainWindowUnload({ window }, reason) {
  if (Zotero.LlmForZoteroSync) {
    await Zotero.LlmForZoteroSync.hooks.onMainWindowUnload(window);
  }
}

function shutdown({ id, version, resourceURI, rootURI }, reason) {
  if (reason === APP_SHUTDOWN) {
    return;
  }

  if (typeof Zotero === "undefined") {
    Zotero = Components.classes["@zotero.org/Zotero;1"].getService(
      Components.interfaces.nsISupports,
    ).wrappedJSObject;
  }

  Zotero.LlmForZoteroSync?.hooks.onShutdown();
  delete Zotero.LlmForZoteroSync;

  Cu.unload(rootURI + "chrome/content/scripts/llm-for-zotero-sync.js");

  if (chromeHandle) {
    chromeHandle.destruct();
    chromeHandle = null;
  }
}

function uninstall() {}
