const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

const isProd = process.env.NODE_ENV === 'production';
const mainPath = isProd 
  ? path.join(__dirname, 'dist', 'main.js')
  : path.join(__dirname, 'src', 'main.ts');

let command;
let args;

if (isProd) {
  command = 'node';
  args = [mainPath];
} else {
  command = 'npx';
  args = ['ts-node', mainPath];
}

console.log(`Executing: ${command} ${args.join(' ')}`);
console.log(`Current directory: ${__dirname}`);

const botProcess = spawn(command, args, {
  stdio: 'inherit',
  cwd: __dirname,
  shell: process.platform === 'win32',
  env: {
    ...process.env,
    DEBUG: 'station-v:*',
    BOTS_CONFIG_PATH: path.join(__dirname, 'bots.json')
  }
});

botProcess.on('close', (code) => {
  console.log(`Bot process exited with code ${code}`);
});

botProcess.on('error', (err) => {
  console.error('Failed to start bot process:', err);
});