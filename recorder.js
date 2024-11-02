const DEFAULT_BITRATES = {
  '3840x2160': 50000000,
  '2560x1440': 32000000,
  '1920x1080': 16000000,
  '1280x720': 8000000,
  '854x480': 4000000,
  '640x360': 2000000
};

let mediaRecorder;
let recordedChunks = [];
let recordedBlob = null;
let timerInterval = null;
let startTime = null;
let isRecording = false;

// Add countdown state tracking
let isCountdownActive = false;
let countdownTimeout = null;

// Cache DOM elements
const elements = {
  init() {
    this.preview = document.getElementById('preview');
    this.player = document.getElementById('player');
    this.playerContainer = document.querySelector('.player-container');
    this.startBtn = document.getElementById('startBtn');
    this.stopBtn = document.getElementById('stopBtn');
    this.downloadBtn = document.getElementById('downloadBtn');
    this.resolution = document.getElementById('resolution');
    this.codec = document.getElementById('codec');
    this.delay = document.getElementById('delay');
    this.statusIndicator = document.getElementById('statusIndicator');
    this.statusText = document.getElementById('statusText');
    this.recordingTimer = document.getElementById('recordingTimer');
    this.timerSection = document.querySelector('.timer-section');
    this.saveSettingsBtn = document.getElementById('saveSettingsBtn');
    this.backBtn = document.getElementById('backBtn');
    this.appContainer = document.querySelector('.app-container');
  }
};

function setTheme(theme) {
  document.documentElement.dataset.theme = theme;
  localStorage.setItem('theme', theme);
}

function toggleTheme() {
  setTheme(document.documentElement.dataset.theme === 'light' ? 'dark' : 'light');
}

async function saveSettings() {
  const settings = {
    resolution: elements.resolution.value,
    codec: elements.codec.value,
    delay: elements.delay.value
  };
  
  try {
    await browser.storage.local.set({ savedRecorderSettings: settings });
    updateStatus('ready', 'Settings saved');
  } catch (error) {
    console.error('Settings save error:', error);
  }
}

async function loadSavedSettings() {
  try {
    const { savedRecorderSettings } = await browser.storage.local.get('savedRecorderSettings');
    if (savedRecorderSettings) {
      elements.resolution.value = savedRecorderSettings.resolution;
      elements.codec.value = savedRecorderSettings.codec;
      elements.delay.value = savedRecorderSettings.delay;
    }
  } catch (error) {
    console.error('Settings load error:', error);
  }
}

function updateStatus(status, text) {
  elements.statusIndicator.className = `status-dot ${status}`;
  elements.statusText.textContent = text;
}

function updateTimer() {
  if (!startTime || !isRecording) return;
  
  const elapsed = Math.floor((Date.now() - startTime) / 1000);
  elements.recordingTimer.textContent = [
    Math.floor(elapsed / 3600),
    Math.floor((elapsed % 3600) / 60),
    elapsed % 60
  ].map(n => n.toString().padStart(2, '0')).join(':');
}

function startTimer() {
  startTime = Date.now();
  isRecording = true;
  updateTimer();
  timerInterval = setInterval(updateTimer, 1000);
  elements.timerSection.classList.add('recording');
}

function stopTimer() {
  isRecording = false;
  clearInterval(timerInterval);
  timerInterval = null;
  if (elements.timerSection) {
    elements.timerSection.classList.remove('recording');
  }
}

function resetTimer() {
  if (elements.recordingTimer) {
    elements.recordingTimer.textContent = '00:00:00';
  }
  stopTimer();
}

// Update stopRecording with better error handling
function stopRecording() {
  try {
    // First check if we're in countdown
    if (isCountdownActive) {
      stopCountdown();
      cleanup();
      updateStatus('ready', 'Countdown cancelled');
      resetUIState();
      return;
    }

    // First check if we have a valid mediaRecorder
    if (!mediaRecorder) {
      console.log('No active recorder found');
      updateStatus('ready', 'Ready');
      cleanup();
      return;
    }

    // Then check its state
    if (mediaRecorder.state === 'inactive') {
      console.log('Recorder already inactive');
      updateStatus('ready', 'Ready');
      cleanup();
      return;
    }

    updateStatus('ready', 'Processing...');
    stopTimer();

    try {
      mediaRecorder.requestData();
    } catch (error) {
      console.warn('Error requesting final data:', error);
    }

    try {
      mediaRecorder.stop();
    } catch (error) {
      console.warn('Error stopping recorder:', error);
    }
    
    // Stop tracks even if mediaRecorder operations fail
    if (elements.preview.srcObject) {
      try {
        elements.preview.srcObject.getTracks().forEach(track => {
          try {
            track.stop();
          } catch (error) {
            console.warn('Error stopping track:', error);
          }
        });
      } catch (error) {
        console.warn('Error accessing tracks:', error);
      }
    }
    
    // Always reset UI state and enable save button
    resetUIState();
    elements.saveSettingsBtn.disabled = false;

  } catch (error) {
    console.error('Stop error:', error);
    updateStatus('ready', 'Recording stopped with errors');
    cleanup();
    resetUIState();
    elements.saveSettingsBtn.disabled = false;
  }
}

// Update startRecording stream handling during countdown
async function startRecording() {
  let stream = null;
  let countdownInterrupted = false;
  
  try {
    cleanup();
    elements.downloadBtn.disabled = true;
    elements.startBtn.disabled = true;
    elements.saveSettingsBtn.disabled = true;
    
    try {
      const resolution = elements.resolution.value.split('x').map(Number);
      // Simplified options - Firefox only supports basic video/audio constraints
      stream = await navigator.mediaDevices.getDisplayMedia({
        video: {
          frameRate: 60,
          width: { ideal: resolution[0] },
          height: { ideal: resolution[1] }
        },
        audio: {
          echoCancellation: true,
          noiseSuppression: true
        }
      });

      if (!stream || !stream.active) {
        throw new Error('Stream is inactive after creation');
      }

      // Add track ended listeners
      stream.getTracks().forEach(track => {
        track.onended = () => {
          countdownInterrupted = true;
          stopCountdown();
          cleanup();
          updateStatus('ready', 'Stream ended by user');
          resetUIState();
        };
      });

      elements.preview.style.display = 'block';
      elements.playerContainer.style.display = 'none';
      elements.preview.srcObject = stream;

    } catch (error) {
      if (error.name === 'NotAllowedError') {
        elements.startBtn.disabled = false;
        await browser.runtime.sendMessage({ action: 'reopenRecorder' });
        window.close();
        return;
      }
      throw error;
    }

    const delaySeconds = parseInt(elements.delay.value);
    if (delaySeconds > 0) {
      isCountdownActive = true;
      elements.startBtn.disabled = true;
      elements.stopBtn.disabled = false;
      elements.resolution.disabled = true;
      elements.codec.disabled = true;
      elements.delay.disabled = true;
      
      for (let i = delaySeconds; i > 0; i--) {
        if (!isCountdownActive || countdownInterrupted) {
          throw new Error('Countdown cancelled');
        }
        
        // Verify stream and tracks are still active
        if (!stream?.active) {
          throw new Error('Stream became inactive during countdown');
        }

        const tracks = stream.getTracks();
        if (tracks.length === 0) {
          throw new Error('No tracks available');
        }

        const inactiveTracks = tracks.filter(track => !track.enabled || track.readyState === 'ended');
        if (inactiveTracks.length > 0) {
          throw new Error('Some tracks became inactive during countdown');
        }
        
        updateStatus('ready', `Starting in ${i} seconds...`);
        try {
          await new Promise((resolve, reject) => {
            countdownTimeout = setTimeout(resolve, 1000);
          });
        } catch (error) {
          throw new Error('Countdown interrupted');
        }
      }
      
      isCountdownActive = false;
    }

    // If countdown was interrupted, don't proceed
    if (countdownInterrupted) {
      throw new Error('Recording cancelled during countdown');
    }

    // Final stream check before creating MediaRecorder
    if (!stream?.active) {
      throw new Error('Stream inactive before recording start');
    }

    const tracks = stream.getTracks();
    if (tracks.length === 0) {
      throw new Error('No tracks available for recording');
    }

    const inactiveTracks = tracks.filter(track => !track.enabled || track.readyState === 'ended');
    if (inactiveTracks.length > 0) {
      throw new Error('Some tracks are inactive before recording start');
    }

    // Update MediaRecorder options to use only supported features
    const options = { mimeType: 'video/webm' }; // Firefox supports WebM by default
    
    mediaRecorder = new MediaRecorder(stream, {
      mimeType: options.mimeType,
      bitsPerSecond: DEFAULT_BITRATES[elements.resolution.value] || 16000000
    });

    mediaRecorder.ondataavailable = e => {
      if (e.data && e.data.size > 0) {
        recordedChunks.push(e.data);
      }
    };
    
    mediaRecorder.onstart = () => {
      updateStatus('recording', 'Recording...');
      startTimer();
    };

    mediaRecorder.onerror = (event) => {
      console.error('MediaRecorder error:', event.error);
      stopRecording();
      updateStatus('ready', 'Recording failed');
    };

    mediaRecorder.onstop = async () => {
      stopTimer();
      try {
        if (recordedChunks.length === 0) {
          throw new Error('No data was recorded');
        }

        recordedBlob = new Blob(recordedChunks, { type: options.mimeType });
        if (recordedBlob.size === 0) {
          throw new Error('Recorded blob is empty');
        }

        elements.downloadBtn.disabled = false;
        updateStatus('stopped', 'Recording complete');
        
        // Clean up old URL if exists
        if (elements.player.src) {
          URL.revokeObjectURL(elements.player.src);
        }
        
        const url = URL.createObjectURL(recordedBlob);
        elements.player.src = url;
        elements.preview.style.display = 'none';
        elements.playerContainer.style.display = 'block';
        
        // Only play if the blob is valid
        if (elements.player.readyState >= 2) {
          elements.player.play().catch(console.error);
        }
      } catch (error) {
        console.error('Recording error:', error);
        updateStatus('ready', 'Recording failed');
        cleanup();
      }
    };

    // Check stream one final time before starting
    if (!stream.active) {
      throw new Error('Stream became inactive before recording could start');
    }

    mediaRecorder.start(1000);
    
    elements.startBtn.disabled = true;
    elements.stopBtn.disabled = false;
    elements.resolution.disabled = true;
    elements.codec.disabled = true;
    elements.delay.disabled = true;
    elements.saveSettingsBtn.disabled = true;
    
    stream.getVideoTracks()[0].onended = () => {
      if (mediaRecorder?.state !== 'inactive') {
        stopRecording();
      }
    };
    
  } catch (error) {
    console.error('Start error:', error);
    updateStatus('ready', error.message || 'Failed to start recording');
    
    // Ensure stream is properly cleaned up
    if (stream) {
      try {
        stream.getTracks().forEach(track => track.stop());
      } catch (e) {
        console.warn('Error stopping tracks during cleanup:', e);
      }
    }
    
    cleanup();
    resetUIState();
    elements.saveSettingsBtn.disabled = false;
  }
}

// Update downloadRecording with better error handling
async function downloadRecording() {
  if (!recordedBlob) return;

  try {
    updateStatus('ready', 'Starting download...');
    const url = URL.createObjectURL(recordedBlob);
    
    const downloadId = await browser.downloads.download({
      url: url,
      filename: `screen-recording-${elements.resolution.value}-${Date.now()}.webm`,
      saveAs: true
    });

    URL.revokeObjectURL(url);

    browser.downloads.onChanged.addListener(function onChanged(delta) {
      if (delta.id === downloadId && delta.state) {
        if (delta.state.current === 'complete') {
          updateStatus('ready', 'Download completed');
        } else if (delta.state.current === 'interrupted') {
          updateStatus('ready', 'Download failed');
        }
        browser.downloads.onChanged.removeListener(onChanged);
      }
    });
  } catch (error) {
    console.error('Download error:', error);
    updateStatus('ready', 'Download failed');
  }
}

// Add cleanup on window unload
window.addEventListener('unload', cleanup);

// Initialize on DOM load
document.addEventListener('DOMContentLoaded', () => {
  elements.init();
  setTheme(localStorage.getItem('theme') || 'light');
  
  // Load minimal mode preference
  const minimalMode = localStorage.getItem('minimalMode') === 'true';
  if (minimalMode) {
    elements.appContainer.classList.add('minimal');
  }
  
  document.addEventListener('click', (e) => {
    const target = e.target.closest('button');
    if (!target) return;
    
    switch(target.id) {
      case 'startBtn': startRecording(); break;
      case 'stopBtn': stopRecording(); break;
      case 'downloadBtn': downloadRecording(); break;
      case 'themeToggle': toggleTheme(); break;
      case 'saveSettingsBtn': saveSettings(); break;
      case 'backBtn': toggleMinimalMode(); break;
    }
  });

  loadSavedSettings();
  updateStatus('ready', 'Ready');
});

// Update cleanup function to be more thorough
function cleanup() {
  try {
    stopCountdown();
    
    if (mediaRecorder && mediaRecorder.state !== 'inactive') {
      mediaRecorder.stop();
    }
    
    if (elements.preview?.srcObject) {
      const tracks = elements.preview.srcObject.getTracks();
      tracks.forEach(track => {
        track.stop();
        elements.preview.srcObject.removeTrack(track);
      });
      elements.preview.srcObject = null;
    }
    
    if (elements.player?.src) {
      URL.revokeObjectURL(elements.player.src);
      elements.player.removeAttribute('src');
      elements.player.load();
    }
    
    recordedChunks = [];
    recordedBlob = null;
    resetTimer();
    
    // Reset UI elements with null checks
    if (elements.preview) {
      elements.preview.style.display = 'block';
    }
    if (elements.playerContainer) {
      elements.playerContainer.style.display = 'none';
    }
    if (elements.downloadBtn) {
      elements.downloadBtn.disabled = true;
    }
    
  } catch (error) {
    console.error('Cleanup error:', error);
  }
}

// Add function to stop countdown
function stopCountdown() {
  isCountdownActive = false;
  if (countdownTimeout) {
    clearTimeout(countdownTimeout);
    countdownTimeout = null;
  }
}

// Add helper function to reset UI state
function resetUIState() {
  elements.startBtn.disabled = false;
  elements.stopBtn.disabled = true;
  elements.resolution.disabled = false;
  elements.codec.disabled = false;
  elements.delay.disabled = false;
  elements.saveSettingsBtn.disabled = false;
}

// Add minimal mode toggle function
function toggleMinimalMode() {
  elements.appContainer.classList.toggle('minimal');
  localStorage.setItem('minimalMode', elements.appContainer.classList.contains('minimal'));
}