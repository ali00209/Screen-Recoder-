const DEFAULT_BITRATES = {
  '3840x2160': 50000000,
  '2560x1440': 32000000,
  '1920x1080': 16000000,
  '1280x720': 8000000,
  '854x480': 4000000,
  '640x360': 2000000
};

const OPTIMAL_BITRATES = {
  '3840x2160': { min: 35000000, ideal: 45000000, max: 55000000 },
  '2560x1440': { min: 25000000, ideal: 32000000, max: 40000000 },
  '1920x1080': { min: 12000000, ideal: 16000000, max: 20000000 }
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
    this.historyBtn = document.getElementById('historyBtn');
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
    elements.historyBtn.disabled = true;
    elements.historyBtn.style.opacity = '0.5';
    
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
        
        // Save to history
        const filename = `screen-recording-${elements.resolution.value}-${Date.now()}.webm`;
        await saveRecordingToDB(recordedBlob, filename);

        // Update player
        if (elements.player.src) {
          URL.revokeObjectURL(elements.player.src);
          elements.player.removeAttribute('src');
          elements.player.load();
        }
        
        const url = URL.createObjectURL(recordedBlob);
        elements.player.src = url;
        elements.preview.style.display = 'none';
        elements.playerContainer.style.display = 'block';
        elements.downloadBtn.disabled = false;
        
        // Try to play
        if (elements.player.readyState >= 2) {
          try {
            await elements.player.play();
          } catch (error) {
            console.warn('Auto-play failed:', error);
          }
        }

        updateStatus('stopped', 'Recording complete');

        // Update history panel if open
        if (document.getElementById('historyOverlay').classList.contains('active')) {
          await updateHistoryPanel();
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
    elements.historyBtn.disabled = false;
    elements.historyBtn.style.opacity = '1';
  }
}

// Add IndexedDB initialization and helper functions
const DB_NAME = 'ScreenRecorderDB';
const DB_VERSION = 1;
const STORE_NAME = 'recordings';

let db;

// Initialize IndexedDB
async function initDB() {
  try {
    db = await new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, DB_VERSION);
      
      request.onerror = () => reject(request.error);
      request.onsuccess = () => resolve(request.result);
      
      request.onupgradeneeded = (event) => {
        const db = event.target.result;
        if (!db.objectStoreNames.contains(STORE_NAME)) {
          const store = db.createObjectStore(STORE_NAME, { keyPath: 'id', autoIncrement: true });
          store.createIndex('timestamp', 'timestamp');
        }
      };
    });
  } catch (error) {
    console.error('IndexedDB initialization error:', error);
  }
}

// Save recording to IndexedDB
async function saveRecordingToDB(blob, filename) {
  try {
    const store = db.transaction(STORE_NAME, 'readwrite').objectStore(STORE_NAME);
    const recording = {
      blob: blob,
      filename: filename,
      timestamp: Date.now(),
      size: blob.size,
      type: blob.type,
      resolution: elements.resolution.value
    };
    await store.add(recording);
  } catch (error) {
    console.error('Error saving to IndexedDB:', error);
  }
}

// Update downloadRecording to use IndexedDB
async function downloadRecording() {
  if (!recordedBlob) return;

  try {
    updateStatus('ready', 'Starting download...');
    const filename = `screen-recording-${elements.resolution.value}-${Date.now()}.webm`;
    
    // Save to IndexedDB first
    await saveRecordingToDB(recordedBlob, filename);
    
    const url = URL.createObjectURL(recordedBlob);
    const downloadId = await browser.downloads.download({
      url: url,
      filename: filename,
      saveAs: true
    });

    URL.revokeObjectURL(url);

    // Monitor download progress
    browser.downloads.onChanged.addListener(function onChanged(delta) {
      if (delta.id === downloadId) {
        if (delta.state) {
          if (delta.state.current === 'complete') {
            updateStatus('ready', 'Download completed');
          } else if (delta.state.current === 'interrupted') {
            updateStatus('ready', 'Download interrupted - saved to temporary storage');
          }
          browser.downloads.onChanged.removeListener(onChanged);
        }
      }
    });
  } catch (error) {
    console.error('Download error:', error);
    updateStatus('ready', 'Download failed');
  }
}

// Update getSavedRecordings function to properly handle the promise
async function getSavedRecordings() {
  try {
    const store = db.transaction(STORE_NAME, 'readonly').objectStore(STORE_NAME);
    return new Promise((resolve, reject) => {
      const request = store.getAll();
      request.onsuccess = () => {
        const recordings = request.result || [];
        // Ensure each recording has a valid blob
        recordings.forEach(recording => {
          if (!(recording.blob instanceof Blob)) {
            recording.blob = new Blob([recording.blob], { type: recording.type });
          }
        });
        resolve(recordings);
      };
      request.onerror = () => reject(request.error);
    });
  } catch (error) {
    console.error('Error getting saved recordings:', error);
    return [];
  }
}

// Add function to delete recording from IndexedDB
async function deleteRecording(id) {
  try {
    const store = db.transaction(STORE_NAME, 'readwrite').objectStore(STORE_NAME);
    await store.delete(id);
  } catch (error) {
    console.error('Error deleting recording:', error);
  }
}

// Update cleanup to handle IndexedDB cleanup
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
  elements.historyBtn.disabled = false;
  elements.historyBtn.style.opacity = '1';
}

// Add minimal mode toggle function
function toggleMinimalMode() {
  elements.appContainer.classList.toggle('minimal');
  localStorage.setItem('minimalMode', elements.appContainer.classList.contains('minimal'));
}

// Add these functions to handle history functionality
function formatFileSize(bytes) {
  if (bytes === 0) return '0 Bytes';
  
  const k = 1024;
  const sizes = ['Bytes', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

function formatDate(timestamp) {
  return new Date(timestamp).toLocaleString();
}

// Update updateHistoryPanel function to add click handlers for recordings
async function updateHistoryPanel() {
  try {
    const recordings = await getSavedRecordings();
    const recordingsList = document.getElementById('recordingsList');
    recordingsList.innerHTML = ''; // Clear existing content

    if (!Array.isArray(recordings) || recordings.length === 0) {
      const noRecordingsItem = document.createElement('div');
      noRecordingsItem.className = 'recording-item';
      noRecordingsItem.style.justifyContent = 'center';
      noRecordingsItem.innerHTML = `<span class="recording-meta">No recordings found</span>`;
      recordingsList.appendChild(noRecordingsItem);
      return;
    }

    recordings.forEach(recording => {
      const item = document.createElement('div');
      item.className = 'recording-item';

      // Create recording info section
      const recordingInfo = document.createElement('div');
      recordingInfo.className = 'recording-info';
      recordingInfo.style.cursor = 'pointer';
      recordingInfo.dataset.id = recording.id;
      
      // Add click handler for the recording info
      recordingInfo.addEventListener('click', async () => {
        try {
          // Update UI to show loading state
          updateStatus('ready', 'Loading recording...');
          
          // Create object URL from the blob
          const url = URL.createObjectURL(recording.blob);
          
          // Update the player source
          elements.preview.style.display = 'none';
          elements.playerContainer.style.display = 'block';
          
          if (elements.player.src) {
            URL.revokeObjectURL(elements.player.src);
          }
          
          elements.player.src = url;
          elements.player.load();
          
          // Enable download button and update recorded blob
          elements.downloadBtn.disabled = false;
          recordedBlob = recording.blob;
          
          // Try to play the video
          try {
            await elements.player.play();
          } catch (error) {
            console.warn('Auto-play failed:', error);
          }
          
          // Close the history overlay
          document.getElementById('historyOverlay').classList.remove('active');
          
          updateStatus('ready', 'Recording loaded');
        } catch (error) {
          console.error('Error loading recording:', error);
          updateStatus('ready', 'Failed to load recording');
        }
      });

      const titleSpan = document.createElement('span');
      titleSpan.className = 'recording-title';
      titleSpan.textContent = recording.filename;

      const metaSpan = document.createElement('span');
      metaSpan.className = 'recording-meta';
      metaSpan.textContent = `${formatFileSize(recording.size)} • ${formatDate(recording.timestamp)}`;

      recordingInfo.appendChild(titleSpan);
      recordingInfo.appendChild(metaSpan);

      // Create recording actions section
      const recordingActions = document.createElement('div');
      recordingActions.className = 'recording-actions';

      // Create download button
      const downloadButton = createActionButton('download', recording.id, 'Download');
      const deleteButton = createActionButton('delete', recording.id, 'Delete');

      recordingActions.appendChild(downloadButton);
      recordingActions.appendChild(deleteButton);

      item.appendChild(recordingInfo);
      item.appendChild(recordingActions);
      recordingsList.appendChild(item);
    });
  } catch (error) {
    console.error('Error updating history panel:', error);
    const recordingsList = document.getElementById('recordingsList');
    recordingsList.innerHTML = `
      <div class="recording-item" style="justify-content: center">
        <span class="recording-meta">Error loading recordings</span>
      </div>
    `;
  }
}

// Add function to show recording in player
async function showRecordingInPlayer(recording) {
  try {
    // Clean up any existing playback
    if (elements.player.src) {
      URL.revokeObjectURL(elements.player.src);
    }
    
    // Create new blob URL and set up player
    const url = URL.createObjectURL(recording.blob);
    elements.player.src = url;
    elements.preview.style.display = 'none';
    elements.playerContainer.style.display = 'block';
    
    // Update UI state
    elements.downloadBtn.disabled = false;
    recordedBlob = recording.blob;
    
    // Only autoplay if video is visible
    const isVisible = await new Promise(resolve => {
      const observer = new IntersectionObserver(([entry]) => {
        observer.disconnect();
        resolve(entry.isIntersecting);
      });
      observer.observe(elements.player);
    });
    
    if (isVisible) {
      try {
        await elements.player.play();
      } catch (error) {
        console.warn('Auto-play failed:', error);
      }
    }
    
    updateStatus('ready', 'Playing recording from history');
  } catch (error) {
    console.error('Error showing recording:', error);
    updateStatus('ready', 'Failed to play recording');
  }
}

// Update history button click handler
document.getElementById('historyBtn').addEventListener('click', async () => {
  const historyOverlay = document.getElementById('historyOverlay');
  historyOverlay.classList.add('active');
  await updateHistoryPanel();
});

// Add close button handler
document.getElementById('closeHistoryBtn').addEventListener('click', () => {
  const historyOverlay = document.getElementById('historyOverlay');
  historyOverlay.classList.remove('active');
});

// Close overlay when clicking outside the modal
document.getElementById('historyOverlay').addEventListener('click', (e) => {
  if (e.target === e.currentTarget) {
    e.currentTarget.classList.remove('active');
  }
});

// Add escape key handler
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    const historyOverlay = document.getElementById('historyOverlay');
    historyOverlay.classList.remove('active');
  }
});

// Add click handler for recording actions
document.getElementById('recordingsList').addEventListener('click', async (e) => {
  const button = e.target.closest('.recording-action-btn');
  if (!button) return;

  const action = button.dataset.action;
  const id = parseInt(button.dataset.id);
  const recordings = await getSavedRecordings();
  const recording = recordings.find(r => r.id === id);

  if (action === 'download') {
    const url = URL.createObjectURL(recording.blob);
    await browser.downloads.download({
      url: url,
      filename: recording.filename,
      saveAs: true
    });
    URL.revokeObjectURL(url);
  } else if (action === 'delete') {
    if (confirm('Are you sure you want to delete this recording?')) {
      await deleteRecording(id);
      await updateHistoryPanel();
      updateStatus('ready', 'Recording deleted');
    }
  }
});

// Add function to clear all recordings
async function clearAllRecordings() {
  try {
    const store = db.transaction(STORE_NAME, 'readwrite').objectStore(STORE_NAME);
    await store.clear();
    await updateHistoryPanel();
    updateStatus('ready', 'All recordings cleared');
  } catch (error) {
    console.error('Error clearing recordings:', error);
    updateStatus('ready', 'Failed to clear recordings');
  }
}

// Update DOMContentLoaded to remove unnecessary initializations
document.addEventListener('DOMContentLoaded', async () => {
  await initDB();
  elements.init();
  
  setTheme(localStorage.getItem('theme') || 'light');
  
  const minimalMode = localStorage.getItem('minimalMode') === 'true';
  if (minimalMode) {
    elements.appContainer.classList.add('minimal');
  }
  
  // Add clear history button listener
  document.getElementById('clearHistoryBtn').addEventListener('click', async () => {
    if (confirm('Are you sure you want to delete all recordings? This cannot be undone.')) {
      await clearAllRecordings();
    }
  });
  
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

class RecorderError extends Error {
  constructor(message, type = 'general') {
    super(message);
    this.name = 'RecorderError';
    this.type = type;
  }
}

async function handleRecordingError(error) {
  // Clean up recording state
  await cleanup();
  
  if (error instanceof RecorderError) {
    switch(error.type) {
      case 'permission':
        updateStatus('error', 'Permission denied - please allow screen sharing');
        break;
      case 'protocol':
        updateStatus('error', 'Connection error - please try again');
        break;
      default:
        updateStatus('error', 'Recording failed - please try again');
    }
  } else {
    updateStatus('error', 'An unexpected error occurred');
  }
  
  resetUIState();
}

function setupErrorRecovery() {
  window.addEventListener('unhandledrejection', async (event) => {
    if (event.reason?.name === 'NotAllowedError') {
      await cleanup();
      resetUIState();
      updateStatus('error', 'Permission denied - please try again');
    }
  });
}

// Replace updateRecordingsList function with this safer version
function updateRecordingsList(recordings) {
  const recordingsList = document.getElementById('recordingsList');
  
  // Clear existing content safely
  while (recordingsList.firstChild) {
    recordingsList.removeChild(recordingsList.firstChild);
  }

  if (!recordings || recordings.length === 0) {
    const emptyItem = document.createElement('div');
    emptyItem.className = 'recording-item';
    emptyItem.style.justifyContent = 'center';
    
    const emptySpan = document.createElement('span');
    emptySpan.className = 'recording-meta';
    emptySpan.textContent = 'No recordings found';
    
    emptyItem.appendChild(emptySpan);
    recordingsList.appendChild(emptyItem);
    return;
  }

  recordings.forEach(recording => {
    const item = document.createElement('div');
    item.className = 'recording-item';

    // Create recording info section
    const recordingInfo = document.createElement('div');
    recordingInfo.className = 'recording-info';
    recordingInfo.style.cursor = 'pointer';
    recordingInfo.dataset.id = recording.id;

    const titleSpan = document.createElement('span');
    titleSpan.className = 'recording-title';
    titleSpan.textContent = recording.filename;

    const metaSpan = document.createElement('span');
    metaSpan.className = 'recording-meta';
    metaSpan.textContent = `${formatFileSize(recording.size)} • ${formatDate(recording.timestamp)}`;

    recordingInfo.appendChild(titleSpan);
    recordingInfo.appendChild(metaSpan);

    // Create recording actions section
    const recordingActions = document.createElement('div');
    recordingActions.className = 'recording-actions';

    // Create download button
    const downloadButton = createActionButton('download', recording.id, 'Download');
    const deleteButton = createActionButton('delete', recording.id, 'Delete');

    recordingActions.appendChild(downloadButton);
    recordingActions.appendChild(deleteButton);

    item.appendChild(recordingInfo);
    item.appendChild(recordingActions);
    recordingsList.appendChild(item);
  });
}

// Helper function to create action buttons
function createActionButton(action, id, title) {
  const button = document.createElement('button');
  button.className = 'recording-action-btn';
  button.dataset.action = action;
  button.dataset.id = id;
  button.title = title;

  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  
  // Add appropriate paths based on action type
  if (action === 'download') {
    const path1 = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path1.setAttribute('d', 'M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4');
    const path2 = document.createElementNS('http://www.w3.org/2000/svg', 'polyline');
    path2.setAttribute('points', '7 10 12 15 17 10');
    const path3 = document.createElementNS('http://www.w3.org/2000/svg', 'line');
    path3.setAttribute('x1', '12');
    path3.setAttribute('y1', '15');
    path3.setAttribute('x2', '12');
    path3.setAttribute('y2', '3');
    svg.appendChild(path1);
    svg.appendChild(path2);
    svg.appendChild(path3);
  } else if (action === 'delete') {
    const path1 = document.createElementNS('http://www.w3.org/2000/svg', 'polyline');
    path1.setAttribute('points', '3 6 5 6 21 6');
    const path2 = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path2.setAttribute('d', 'M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2');
    svg.appendChild(path1);
    svg.appendChild(path2);
  }

  button.appendChild(svg);
  return button;
}

const VALID_VIDEO_TYPES = [
  "video/webm",
  "video/mp4",
  "video/x-matroska"
];

function isValidFileType(file) {
  return VALID_VIDEO_TYPES.includes(file.type);
}

function handleFile(file) {
  if (!isValidFileType(file)) {
    throw new Error('Invalid file type. Only WebM, MP4, and MKV formats are supported.');
  }
  
  return {
    name: file.name,
    size: file.size,
    type: file.type,
    lastModified: file.lastModified
  };
}

function updateFilePreview(file) {
  const previewContainer = document.getElementById('preview');
  
  // Clear previous preview
  while (previewContainer.firstChild) {
    previewContainer.removeChild(previewContainer.firstChild);
  }
  
  const fileInfo = document.createElement('div');
  fileInfo.className = 'file-info';
  
  const nameElement = document.createElement('p');
  nameElement.textContent = `File: ${file.name}`;
  
  const sizeElement = document.createElement('p');
  sizeElement.textContent = `Size: ${formatFileSize(file.size)}`;
  
  fileInfo.appendChild(nameElement);
  fileInfo.appendChild(sizeElement);
  
  previewContainer.appendChild(fileInfo);
}

// Add hover effect styles for recording items
const additionalStyles = `
.recording-info:hover {
  background-color: var(--hover-color);
  border-radius: 0.375rem;
}

.recording-item {
  transition: all 0.2s ease;
}

.recording-item:hover {
  transform: translateX(4px);
}
`;

// Add the styles to the document
const styleSheet = document.createElement('style');
styleSheet.textContent = additionalStyles;
document.head.appendChild(styleSheet);