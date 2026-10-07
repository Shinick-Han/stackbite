#!/usr/bin/env node
'use strict';
const { main } = require('../lib/bootstrap');
main().then(({ code, signal }) => {
  if (signal && process.platform !== 'win32') {
    process.kill(process.pid, signal);
  } else {
    process.exitCode = code === null ? 1 : code;
  }
}).catch(error => {
  console.error(`Stackbite: ${error.message}`);
  process.exitCode = 1;
});
