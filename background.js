let recorderWindowId = null;
let isCreatingWindow = false;
let windowPosition = null;

// Cache window position for faster reopening
async function cacheWindowPosition() {
  try {
    const screen = await browser.windows.getCurrent({ windowTypes: ['normal'] });
    const width = 850;
    const height = 700;
    const screenWidth = window.screen.availWidth || screen.width;
    const screenHeight = window.screen.availHeight || screen.height;
    
    windowPosition = {
      left: Math.min(Math.max(0, Math.floor((screenWidth - width) / 2)), screenWidth - width),
      top: Math.min(Math.max(0, Math.floor((screenHeight - height) / 2)), screenHeight - height),
      width,
      height
    };
  } catch (error) {
    console.error('Error caching position:', error);
    // Fallback position
    windowPosition = { left: 100, top: 100, width: 850, height: 700 };
  }
}

// Function to check if window exists and is valid
async function isWindowValid(windowId) {
    if (!windowId) return false;
    try {
        const window = await browser.windows.get(windowId);
        return window && !window.incognito && window.type === "popup";
    } catch {
        return false;
    }
}

// Function to focus existing window
async function focusExistingWindow(windowId) {
    if (!windowId) return false;
    try {
        await browser.windows.update(windowId, {
            focused: true,
            drawAttention: true
        });
        return true;
    } catch {
        return false;
    }
}

// Function to create new window
async function createRecorderWindow() {
    if (isCreatingWindow) return;
    isCreatingWindow = true;

    try {
        // Close existing window if any
        if (recorderWindowId !== null) {
            try {
                await browser.windows.remove(recorderWindowId);
            } catch {}
            cleanupWindow();
        }

        // Use cached position or create new
        if (!windowPosition) {
            await cacheWindowPosition();
        }

        const window = await browser.windows.create({
            url: "recorder.html",
            type: "popup",
            ...windowPosition,
            allowScriptsToClose: true
        });
        
        recorderWindowId = window.id;
        
        if (!await isWindowValid(recorderWindowId)) {
            throw new Error('Created window is not valid');
        }
    } catch (error) {
        console.error('Error creating window:', error);
        cleanupWindow();
    } finally {
        isCreatingWindow = false;
    }
}

// Main click handler with debounce
let clickTimeout = null;
browser.browserAction.onClicked.addListener(async () => {
    if (clickTimeout) return;
    
    clickTimeout = setTimeout(() => {
        clickTimeout = null;
    }, 1000);

    try {
        if (recorderWindowId !== null) {
            const isValid = await isWindowValid(recorderWindowId);
            
            if (isValid) {
                const focused = await focusExistingWindow(recorderWindowId);
                if (focused) return;
            }
            
            cleanupWindow();
        }

        await createRecorderWindow();

    } catch (error) {
        console.error('Error in click handler:', error);
        cleanupWindow();
    }
});

// Listen for window removal
browser.windows.onRemoved.addListener((windowId) => {
    if (windowId === recorderWindowId) {
        cleanupWindow();
    }
});

// Listen for window state changes
browser.windows.onFocusChanged.addListener(async (windowId) => {
    if (windowId === recorderWindowId) {
        const isValid = await isWindowValid(recorderWindowId);
        if (!isValid) {
            cleanupWindow();
        }
    }
});

// Cache position on extension startup
browser.runtime.onStartup.addListener(() => {
    cacheWindowPosition();
    cleanupWindow();
});

// Add message listener for reopening
browser.runtime.onMessage.addListener(async (message) => {
    if (message.action === 'reopenRecorder') {
        cleanupWindow();
        await createRecorderWindow();
    }
});

// Update cleanupWindow function
function cleanupWindow() {
    if (recorderWindowId) {
        try {
            browser.windows.get(recorderWindowId).then(() => {
                browser.windows.remove(recorderWindowId);
            }).catch(() => {});
        } catch {}
    }
    recorderWindowId = null;
    isCreatingWindow = false;
}

async function handleProtocolError(error) {
  console.error('Protocol error:', error);
  
  if (error.message?.includes('Extension is invalid')) {
    // Handle extension validation errors
    await browser.notifications.create({
      type: 'basic',
      title: 'Extension Error',
      message: 'There was an issue with the extension. Please try reinstalling.',
      iconUrl: 'icons/icon-48.png'
    });
    return false;
  }
  
  return true;
}

async function reportError(error) {
  const errorReport = {
    timestamp: new Date().toISOString(),
    message: error.message,
    stack: error.stack,
    type: error.name,
    version: browser.runtime.getManifest().version
  };

  try {
    await browser.storage.local.set({
      errorLogs: errorReport
    });
  } catch (e) {
    console.error('Failed to save error report:', e);
  }
}