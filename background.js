let recorderWindowId = null;
let isCreatingWindow = false;

// Function to check if window exists and is valid
async function isWindowValid(windowId) {
    try {
        const window = await browser.windows.get(windowId);
        return window && !window.incognito && window.type === "popup";
    } catch (error) {
        return false;
    }
}

// Function to focus existing window
async function focusExistingWindow(windowId) {
    try {
        await browser.windows.update(windowId, {
            focused: true,
            drawAttention: true
        });
        return true;
    } catch (error) {
        console.error('Error focusing window:', error);
        return false;
    }
}

// Function to get centered position
async function getCenteredPosition(width, height) {
    try {
        const screen = await browser.windows.getCurrent({ windowTypes: ['normal'] });
        const screenWidth = window.screen.availWidth || screen.width;
        const screenHeight = window.screen.availHeight || screen.height;
        
        const left = Math.max(0, Math.floor((screenWidth - width) / 2));
        const top = Math.max(0, Math.floor((screenHeight - height) / 2));
        
        return {
            left: Math.min(left, screenWidth - width),
            top: Math.min(top, screenHeight - height),
            width,
            height
        };
    } catch (error) {
        console.error('Error calculating center position:', error);
        return {
            left: Math.floor((1920 - width) / 2),
            top: Math.floor((1080 - height) / 2),
            width,
            height
        };
    }
}

// Function to create new window
async function createRecorderWindow() {
    if (isCreatingWindow) {
        return;
    }

    isCreatingWindow = true;
    try {
        if (recorderWindowId !== null) {
            try {
                await browser.windows.remove(recorderWindowId);
            } catch (error) {
                console.error('Error closing existing window:', error);
            }
            cleanupWindow();
        }

        const position = await getCenteredPosition(850, 700);
        const window = await browser.windows.create({
            url: "recorder.html",
            type: "popup",
            ...position,
            allowScriptsToClose: true
        });
        
        recorderWindowId = window.id;
        
        const isValid = await isWindowValid(recorderWindowId);
        if (!isValid) {
            throw new Error('Created window is not valid');
        }
    } catch (error) {
        console.error('Error creating window:', error);
        cleanupWindow();
    } finally {
        isCreatingWindow = false;
    }
}

// Main click handler
browser.browserAction.onClicked.addListener(async () => {
    try {
        if (recorderWindowId !== null) {
            const isValid = await isWindowValid(recorderWindowId);
            
            if (isValid) {
                const focused = await focusExistingWindow(recorderWindowId);
                if (focused) {
                    return;
                }
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

// Clean up on extension startup
browser.runtime.onStartup.addListener(() => {
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
            }).catch(() => {
                // Window already closed, ignore
            });
        } catch (error) {
            // Ignore cleanup errors
        }
    }
    recorderWindowId = null;
    isCreatingWindow = false;
}