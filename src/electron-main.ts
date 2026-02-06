import { app, BrowserWindow, Menu, ipcMain } from 'electron';
import * as path from 'path';
import { setupElectronConfigSync } from './services/electronConfigSync';
import { agentGuiService } from './services/agentGuiService';
import { botConfigGuiService } from './services/botConfigGuiService';
import { simulationGuiService } from './services/simulationGuiService';
import { logsGuiService } from './services/logsGuiService';

// Keep a global reference of the window object
let mainWindow: BrowserWindow | null = null;

function createMainWindow(): void {
  // Create the browser window
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.js')
    },
    title: 'Discord Bot Control Panel',
    icon: path.join(__dirname, '../assets/icon.png'), // Add icon if available
    show: false
  });

  // Load the main interface (you can create this later)
  mainWindow.loadFile(path.join(__dirname, 'main-interface.html'));

  // Show window when ready
  mainWindow.once('ready-to-show', () => {
    mainWindow?.show();
  });

  // Emitted when the window is closed
  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  // Setup menu
  setupMenu();
}

function setupMenu(): void {
  const template: Electron.MenuItemConstructorOptions[] = [
    {
      label: 'File',
      submenu: [
        {
          label: 'Open Agent Manager',
          accelerator: 'CmdOrCtrl+A',
          click: () => {
            agentGuiService.showAgentWindow();
          }
        },
        { type: 'separator' },
        {
          label: 'Quit',
          accelerator: process.platform === 'darwin' ? 'Cmd+Q' : 'Ctrl+Q',
          click: () => {
            app.quit();
          }
        }
      ]
    },
    {
      label: 'Tools',
      submenu: [
        {
          label: 'Agent Manager',
          accelerator: 'CmdOrCtrl+Shift+A',
          click: () => {
            agentGuiService.showAgentWindow();
          }
        },
        {
          label: 'Bot Configuration',
          accelerator: 'CmdOrCtrl+B',
          click: () => {
            botConfigGuiService.showBotConfigWindow();
          }
        },
        {
          label: 'Simulation Control',
          accelerator: 'CmdOrCtrl+S',
          click: () => {
            simulationGuiService.showSimulationWindow();
          }
        },
        {
          label: 'Logs & Analytics',
          accelerator: 'CmdOrCtrl+L',
          click: () => {
            logsGuiService.showLogsWindow();
          }
        }
      ]
    },
    {
      label: 'View',
      submenu: [
        { role: 'reload' },
        { role: 'forceReload' },
        { role: 'toggleDevTools' },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' }
      ]
    }
  ];

  const menu = Menu.buildFromTemplate(template);
  Menu.setApplicationMenu(menu);
}

// This method will be called when Electron has finished initialization
app.whenReady().then(() => {
  createMainWindow();

  // Setup IPC handlers for config sync
  setupElectronConfigSync();

  // Setup window control IPC handlers
  ipcMain.handle('window:minimize', () => {
    BrowserWindow.getFocusedWindow()?.minimize();
  });

  ipcMain.handle('window:maximize', () => {
    const win = BrowserWindow.getFocusedWindow();
    if (win?.isMaximized()) {
      win.unmaximize();
    } else {
      win?.maximize();
    }
  });

  ipcMain.handle('window:close', () => {
    BrowserWindow.getFocusedWindow()?.close();
  });

  ipcMain.handle('open-agent-manager', () => {
    agentGuiService.showAgentWindow();
  });

  ipcMain.handle('open-bot-config', () => {
    botConfigGuiService.showBotConfigWindow();
  });

  ipcMain.handle('open-simulation', () => {
    simulationGuiService.showSimulationWindow();
  });

  ipcMain.handle('open-logs', () => {
    logsGuiService.showLogsWindow();
  });

  app.on('activate', () => {
    // On macOS it's common to re-create a window in the app when the
    // dock icon is clicked and there are no other windows open
    if (BrowserWindow.getAllWindows().length === 0) {
      createMainWindow();
    }
  });
});

// Quit when all windows are closed, except on macOS
app.on('window-all-closed', () => {
  // On macOS it is common for applications and their menu bar
  // to stay active until the user quits explicitly with Cmd + Q
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

// Security: Prevent navigation to external websites
app.on('web-contents-created', (event, contents) => {
  contents.on('will-navigate', (event, navigationUrl) => {
    const parsedUrl = new URL(navigationUrl);

    if (parsedUrl.origin !== 'file://') {
      event.preventDefault();
    }
  });
});

// Handle app being opened from command line or file manager
app.on('open-file', (event, path) => {
  event.preventDefault();
  // Handle opening files if needed
});

export { createMainWindow };
