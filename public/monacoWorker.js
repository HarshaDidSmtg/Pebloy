self.MonacoEnvironment = { baseUrl: `${self.location.origin}/vendor/monaco/` };
importScripts(`${self.MonacoEnvironment.baseUrl}vs/base/worker/workerMain.js`);