/**
 * YourTime - Roommate Cleaning Task Manager
 * Core Application Logic & Scheduling Engine
 */

// --- 1. Configurations ---
const ROOMMATES = ['Sreehari', 'Adhi', 'Raju'];
const WEEKLY_TASKS = [
  { id: 'bathroom', name: 'Bathroom cleaning' },
  { id: 'kitchen', name: 'Kitchen cleaning' },
  { id: 'corridor', name: 'Corridor cleaning' }
];
const WASTE_TASK = { id: 'waste', name: 'Waste disposal' };

// Rotation Order Configurations
// Weekly duties shift index cyclical order (e.g. Sreehari -> Adhi -> Raju)
// Subsidiary duty order always starts with Adhi -> Sreehari -> Raju
const WASTE_ROOMMATES = ['Adhi', 'Sreehari', 'Raju'];

// Reference Epochs for Deterministic Calculations
// Reference Monday: Monday, June 1, 2026 00:00:00 (Week index 0 starts)
// Weekend 0 is Friday, June 5 00:00:00 to Sunday, June 7 23:59:59
const REF_WEEKLY_MONDAY = new Date('2026-06-01T00:00:00').getTime();

// Reference Start for Waste (2-day interval): Wednesday, June 3, 2026 00:00:00 (Interval index 0 starts)
// Interval 0 ends Thursday, June 4 23:59:59. (Assigned to Adhi, due today evening)
const REF_WASTE_START = new Date('2026-06-03T00:00:00').getTime();

// Constant mills
const DAY_MS = 24 * 60 * 60 * 1000;
const WEEK_MS = 7 * DAY_MS;

// --- 2. State Management ---
let activeTasks = [];
let historyLogs = [];
let mockDate = null; // Stores simulation date, if active. Otherwise null (uses system clock)
let pendingFirestoreReset = false; // True after a version bump — forces Firestore overwrite on connect

/**
 * Gets the current active timestamp (mock or real)
 * @returns {Date}
 */
function getCurrentTime() {
  if (mockDate) {
    return new Date(mockDate);
  }
  return new Date();
}

/**
 * Saves state to localStorage
 */
function saveState() {
  localStorage.setItem('yt_active_tasks', JSON.stringify(activeTasks));
  localStorage.setItem('yt_history', JSON.stringify(historyLogs));
}

/**
 * Loads state from localStorage or initializes if empty
 */
function loadState() {
  const APP_VERSION = 'v3.2';
  const storedVersion = localStorage.getItem('yt_version');
  if (storedVersion !== APP_VERSION) {
    localStorage.clear();
    localStorage.setItem('yt_version', APP_VERSION);
    // Flag that Firestore must be overwritten with fresh state (old rotation config is stale)
    pendingFirestoreReset = true;
  }

  const savedActive = localStorage.getItem('yt_active_tasks');
  const savedHistory = localStorage.getItem('yt_history');
  
  activeTasks = savedActive ? JSON.parse(savedActive) : [];
  historyLogs = savedHistory ? JSON.parse(savedHistory) : [];
  
  // Try loading simulation date if set previously
  const savedMock = localStorage.getItem('yt_mock_date');
  if (savedMock) {
    mockDate = new Date(savedMock);
    document.getElementById('mock-date-input').value = savedMock.substring(0, 10);
    document.getElementById('mock-time-input').value = savedMock.substring(11, 16);
    updateMockIndicator();
  }
}

// --- 3. Chore Rotation Mathematical Formulas ---

/**
 * Calculates current Week index relative to Reference Monday (June 1, 2026)
 * @param {Date} date 
 * @returns {number}
 */
function getWeekIndex(date) {
  const diff = date.getTime() - REF_WEEKLY_MONDAY;
  return Math.floor(diff / WEEK_MS);
}

/**
 * Calculates 2-day Interval index relative to Reference Waste Start (June 2, 2026)
 * @param {Date} date 
 * @returns {number}
 */
function getWasteIntervalIndex(date) {
  const diff = date.getTime() - REF_WASTE_START;
  return Math.floor(diff / (2 * DAY_MS));
}

/**
 * Computes weekly roommates assignments for a given weekIndex
 * @param {number} weekIndex 
 * @returns {object} Maps taskId to Roommate name
 */
function getWeeklyAssignments(weekIndex) {
  // Cyclical rotation offset:
  // Week 0: Bathroom->Sreehari(0), Kitchen->Adhi(1), Corridor->Raju(2)
  // Week 1: Bathroom->Adhi(1), Kitchen->Raju(2), Corridor->Sreehari(0)
  // Week 2: Bathroom->Raju(2), Kitchen->Sreehari(0), Corridor->Adhi(1)
  const assignments = {};
  WEEKLY_TASKS.forEach((task, i) => {
    const rIndex = ((i + weekIndex) % 3 + 3) % 3;
    assignments[task.id] = ROOMMATES[rIndex];
  });
  return assignments;
}

/**
 * Computes waste disposal roommate assignment for a given intervalIndex
 * @param {number} intervalIndex 
 * @returns {string} Roommate name
 */
function getWasteAssignment(intervalIndex) {
  // Always starts with Raju -> Sreehari -> Adhi
  const rIndex = ((intervalIndex % 3) + 3) % 3;
  return WASTE_ROOMMATES[rIndex];
}

// --- 4. Task Generation Logic (Scheduler) ---

/**
 * Automatically creates task instances for all active/past intervals
 * up to the current simulated date, checking localStorage to avoid duplicates.
 */
function updateState() {
  const now = getCurrentTime();
  const nowMs = now.getTime();
  
  // 1. Generate weekly chores
  const currentWeek = getWeekIndex(now);
  
  // Safety: Cap weekly checks to the last 3 weeks + current week to prevent database pollution
  const startWeekCheck = Math.max(0, currentWeek - 3);
  
  for (let w = startWeekCheck; w <= currentWeek; w++) {
    // Week details
    const weekMondayMs = REF_WEEKLY_MONDAY + (w * WEEK_MS);
    const fridayMs = weekMondayMs + (4 * DAY_MS); // Friday 00:00
    const SundayEndMs = weekMondayMs + (7 * DAY_MS) - 1000; // Sunday 23:59:59
    
    // Only activate tasks if current date has reached Friday of that week
    if (nowMs >= fridayMs) {
      const assignments = getWeeklyAssignments(w);
      
      WEEKLY_TASKS.forEach(task => {
        const taskId = `weekly-${w}-${task.id}`;
        
        // Check if task exists in active list OR completed history
        const inActive = activeTasks.some(t => t.id === taskId);
        const inHistory = historyLogs.some(t => t.id === taskId);
        
        if (!inActive && !inHistory) {
          activeTasks.push({
            id: taskId,
            type: 'weekly',
            taskId: task.id,
            name: task.name,
            roommate: assignments[task.id],
            startDate: fridayMs,
            deadline: SundayEndMs,
            periodId: `Week ${w} (Weekend)`
          });
        }
      });
    }
  }
  
  // 2. Generate 2-day subsidiary chores
  const currentInterval = getWasteIntervalIndex(now);
  
  // Safety: Cap check to last 5 intervals to prevent clogging list if time travels far
  const startIntervalCheck = Math.max(0, currentInterval - 5);
  
  for (let i = startIntervalCheck; i <= currentInterval; i++) {
    const startMs = REF_WASTE_START + (i * 2 * DAY_MS);
    const endMs = startMs + (2 * DAY_MS) - 1000; // 2-day deadline (at 23:59:59 of second day)
    
    if (nowMs >= startMs) {
      const taskId = `waste-${i}`;
      
      const inActive = activeTasks.some(t => t.id === taskId);
      const inHistory = historyLogs.some(t => t.id === taskId);
      
      if (!inActive && !inHistory) {
        activeTasks.push({
          id: taskId,
          type: 'waste',
          taskId: 'waste',
          name: WASTE_TASK.name,
          roommate: getWasteAssignment(i),
          startDate: startMs,
          deadline: endMs,
          periodId: `Interval ${i}`
        });
      }
    }
  }
  
  saveState();
}

/**
 * Marks a chore as completed and logs it to history.
 * @param {string} taskId Unique ID of the task
 */
function completeTask(taskId) {
  const taskIndex = activeTasks.findIndex(t => t.id === taskId);
  if (taskIndex === -1) return;
  
  const task = activeTasks[taskIndex];
  const now = getCurrentTime();
  
  // Determine if completed on time or late
  const isCompletedOnTime = now.getTime() <= task.deadline;
  const status = isCompletedOnTime ? 'on-time' : 'late';
  
  // Add to history log
  historyLogs.push({
    id: task.id,
    type: task.type,
    taskId: task.taskId,
    name: task.name,
    roommate: task.roommate,
    deadline: task.deadline,
    startDate: task.startDate,
    periodId: task.periodId,
    completionTime: now.getTime(),
    status: status
  });
  
  // Remove from active tasks list
  activeTasks.splice(taskIndex, 1);
  saveState();
  
  renderApp();
  pushToFirestore();
}

/**
 * Reverts a completed task from history back to active list.
 * @param {string} historyId Unique ID of the task
 */
function undoTask(historyId) {
  const hIndex = historyLogs.findIndex(h => h.id === historyId);
  if (hIndex === -1) return;
  
  const hItem = historyLogs[hIndex];
  
  // Re-add to active tasks
  activeTasks.push({
    id: hItem.id,
    type: hItem.type,
    taskId: hItem.taskId,
    name: hItem.name,
    roommate: hItem.roommate,
    startDate: hItem.startDate,
    deadline: hItem.deadline,
    periodId: hItem.periodId
  });
  
  // Remove from history
  historyLogs.splice(hIndex, 1);
  saveState();
  
  renderApp();
  pushToFirestore();
}

// --- 5. UI Rendering & Helpers ---

/**
 * Formats a timestamp into human-readable date & time
 * @param {number} ms 
 * @returns {string}
 */
function formatDate(ms) {
  const d = new Date(ms);
  const options = { weekday: 'short', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' };
  return d.toLocaleDateString('en-US', options);
}

/**
 * Formats date range for weekly cycles
 * @param {number} weekIndex 
 * @returns {string}
 */
function formatWeekRange(weekIndex) {
  const mon = new Date(REF_WEEKLY_MONDAY + weekIndex * WEEK_MS);
  const fri = new Date(mon.getTime() + 4 * DAY_MS);
  const sun = new Date(mon.getTime() + 6 * DAY_MS);
  
  const options = { month: 'short', day: 'numeric' };
  return `Weekend (${fri.toLocaleDateString('en-US', options)} - ${sun.toLocaleDateString('en-US', options)})`;
}

/**
 * Updates simulation alert banner
 */
function updateMockIndicator() {
  const statusEl = document.getElementById('mock-active-status');
  if (mockDate) {
    statusEl.textContent = 'Active (Simulation)';
    statusEl.className = 'status-indicator active';
  } else {
    statusEl.textContent = 'Inactive (Real-Time)';
    statusEl.className = 'status-indicator inactive';
  }
}

/**
 * Renders all dynamic DOM parts of the application
 */
function renderApp() {
  const now = getCurrentTime();
  const nowMs = now.getTime();
  const currentWeek = getWeekIndex(now);
  
  // 1. Update Header Time
  const dateOptions = { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric', hour: '2-digit', minute: '2-digit' };
  document.getElementById('header-date-text').textContent = now.toLocaleDateString('en-US', dateOptions);
  
  // 2. Separate active tasks into Weekly and Subsidiary lists
  const weeklyContainer = document.getElementById('weekly-cards-container');
  const subsidiaryContainer = document.getElementById('subsidiary-cards-container');
  const emptyState = document.getElementById('no-active-tasks');
  const activeCountBadge = document.getElementById('active-tasks-count');
  
  weeklyContainer.innerHTML = '';
  subsidiaryContainer.innerHTML = '';
  
  // Sort active tasks: Overdue first, then by deadline
  const sortedTasks = [...activeTasks].sort((a, b) => {
    const aOverdue = nowMs > a.deadline;
    const bOverdue = nowMs > b.deadline;
    if (aOverdue && !bOverdue) return -1;
    if (!aOverdue && bOverdue) return 1;
    return a.deadline - b.deadline;
  });
  
  let weeklyCount = 0;
  let subsidiaryCount = 0;
  
  sortedTasks.forEach(task => {
    const isOverdue = nowMs > task.deadline;
    const statusClass = isOverdue ? 'overdue' : 'pending';
    const statusText = isOverdue ? 'Overdue' : 'Pending';
    const badgeClass = isOverdue ? 'badge-overdue' : 'badge-pending';
    
    // UI Card HTML template
    const cardHtml = `
      <div class="chore-card ${statusClass}" data-id="${task.id}">
        <div class="chore-details">
          <div class="chore-main">
            <span class="chore-name">${task.name}</span>
            <span class="badge ${badgeClass}">${statusText}</span>
          </div>
          <div class="chore-meta">
            <div class="meta-item">
              <span class="badge badge-roommate">${task.roommate}</span>
            </div>
            <span class="divider">|</span>
            <div class="meta-item">
              <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <circle cx="12" cy="12" r="10"></circle>
                <polyline points="12 6 12 12 16 14"></polyline>
              </svg>
              <span>Due: <strong>${formatDate(task.deadline)}</strong></span>
            </div>
          </div>
        </div>
        <div class="complete-action">
          <button class="btn-complete" onclick="completeTask('${task.id}')">
            <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
              <polyline points="20 6 9 17 4 12"></polyline>
            </svg>
            Done
          </button>
        </div>
      </div>
    `;
    
    if (task.type === 'weekly') {
      weeklyContainer.insertAdjacentHTML('beforeend', cardHtml);
      weeklyCount++;
    } else {
      subsidiaryContainer.insertAdjacentHTML('beforeend', cardHtml);
      subsidiaryCount++;
    }
  });
  
  // Toggle empty lists view
  document.getElementById('weekly-group').style.display = weeklyCount > 0 ? 'flex' : 'none';
  document.getElementById('subsidiary-group').style.display = subsidiaryCount > 0 ? 'flex' : 'none';
  
  const totalActive = activeTasks.length;
  activeCountBadge.textContent = totalActive;
  emptyState.style.display = totalActive === 0 ? 'block' : 'none';
  
  // 3. Render Leaderboard / Performance Cards
  ROOMMATES.forEach(roommate => {
    const roommateHistory = historyLogs.filter(h => h.roommate === roommate);
    const completedCount = roommateHistory.length;
    
    const onTimeCount = roommateHistory.filter(h => h.status === 'on-time').length;
    const onTimeRate = completedCount > 0 ? Math.round((onTimeCount / completedCount) * 100) : 100;
    
    document.getElementById(`stats-completed-${roommate}`).textContent = completedCount;
    const rateEl = document.getElementById(`stats-ontime-${roommate}`);
    rateEl.textContent = `${onTimeRate}%`;
    
    // Color code metrics based on percentage
    if (onTimeRate < 60) {
      rateEl.className = 'metric-val text-red';
    } else if (onTimeRate < 85) {
      rateEl.className = 'metric-val'; // neutral
    } else {
      rateEl.className = 'metric-val text-green';
    }
    
    const fillEl = document.getElementById(`progress-bar-${roommate}`);
    fillEl.style.width = `${onTimeRate}%`;
    
    // Change bar color if rates drop low
    if (onTimeRate < 60) {
      fillEl.style.background = 'linear-gradient(90deg, var(--status-red), var(--status-red))';
    } else {
      fillEl.style.background = 'linear-gradient(90deg, var(--primary), var(--status-green))';
    }
  });
  
  // 4. Render History Log Table
  renderHistoryTable();
  
  // 5. Render Upcoming Week Duties Preview
  renderUpcomingWeekDuties(currentWeek, nowMs);
}

/**
 * Filters and renders history table
 */
function renderHistoryTable() {
  const tbody = document.getElementById('history-tbody');
  const emptyHistory = document.getElementById('no-history');
  tbody.innerHTML = '';
  
  const query = document.getElementById('history-search').value.toLowerCase();
  const userFilter = document.getElementById('history-filter-user').value;
  const statusFilter = document.getElementById('history-filter-status').value;
  
  const filtered = historyLogs.filter(h => {
    // Search filter
    const matchesQuery = h.name.toLowerCase().includes(query) || h.roommate.toLowerCase().includes(query);
    // User filter
    const matchesUser = userFilter === 'all' || h.roommate === userFilter;
    // Status filter
    const matchesStatus = statusFilter === 'all' || h.status === statusFilter;
    
    return matchesQuery && matchesUser && matchesStatus;
  }).sort((a, b) => b.completionTime - a.completionTime); // Recent completed first
  
  if (filtered.length === 0) {
    emptyHistory.style.display = 'block';
    return;
  }
  
  emptyHistory.style.display = 'none';
  
  filtered.forEach(h => {
    const isSuccess = h.status === 'on-time';
    const pillClass = isSuccess ? 'status-pill-green' : 'status-pill-red';
    const textLabel = isSuccess ? 'On Time' : 'Late';
    
    const rowHtml = `
      <tr>
        <td><strong>${h.name}</strong></td>
        <td><span class="badge badge-roommate">${h.roommate}</span></td>
        <td class="text-muted">${formatDate(h.deadline)}</td>
        <td>${formatDate(h.completionTime)}</td>
        <td>
          <span class="status-pill ${pillClass}">
            <svg width="8" height="8" viewBox="0 0 8 8" fill="currentColor">
              <circle cx="4" cy="4" r="4"></circle>
            </svg>
            ${textLabel}
          </span>
        </td>
        <td>
          <button class="btn btn-secondary btn-xs" onclick="undoTask('${h.id}')" title="Revert Completed Chores">
            <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" style="margin-right: 2px;">
              <path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"></path>
              <polyline points="3 3 3 8 8 8"></polyline>
            </svg>
            Undo
          </button>
        </td>
      </tr>
    `;
    tbody.insertAdjacentHTML('beforeend', rowHtml);
  });
}

/**
 * Renders the upcoming week's main chores assignment
 * @param {number} currentWeekIndex
 * @param {number} nowMs
 */
function renderUpcomingWeekDuties(currentWeekIndex, nowMs) {
  const upcomingListEl = document.getElementById('upcoming-roommates-list');
  if (!upcomingListEl) return;
  upcomingListEl.innerHTML = '';
  
  // Calculate which weekend is "upcoming" relative to now.
  // If the current week's weekend has already started, show next week's weekend.
  const weekMondayMs = REF_WEEKLY_MONDAY + (currentWeekIndex * WEEK_MS);
  const fridayMs = weekMondayMs + (4 * DAY_MS); // Friday 00:00
  
  let upcomingWeekIndex = currentWeekIndex;
  if (nowMs >= fridayMs) {
    upcomingWeekIndex = currentWeekIndex + 1;
  }
  
  // Update section subtitle with the upcoming weekend dates
  const subtitleEl = document.getElementById('upcoming-week-subtitle');
  if (subtitleEl) {
    subtitleEl.textContent = formatWeekRange(upcomingWeekIndex);
  }
  
  const assignments = getWeeklyAssignments(upcomingWeekIndex);
  
  // Map roommate to assignment name
  const roommateDuties = {};
  WEEKLY_TASKS.forEach(task => {
    roommateDuties[assignments[task.id]] = task.name;
  });
  
  ROOMMATES.forEach(roommate => {
    const taskName = roommateDuties[roommate];
    // Shorten name if needed, e.g. "Bathroom cleaning" -> "Bathroom"
    const displayTaskName = taskName.replace(' cleaning', '');
    const initials = roommate === 'Sreehari' ? 'SH' : roommate === 'Adhi' ? 'AD' : 'RJ';
    const avatarClass = roommate === 'Sreehari' ? 'avatar-sreehari' : roommate === 'Adhi' ? 'avatar-adhi' : 'avatar-raju';
    
    const rowHtml = `
      <div class="upcoming-member-row">
        <div class="upcoming-member-left">
          <div class="upcoming-avatar ${avatarClass}">${initials}</div>
          <span class="upcoming-name">${roommate}</span>
        </div>
        <span class="upcoming-duty">${displayTaskName}</span>
      </div>
    `;
    upcomingListEl.insertAdjacentHTML('beforeend', rowHtml);
  });
}

/// --- 6. Firebase Firestore Synchronization ---

// ─────────────────────────────────────────────────────────────────────────────
// SETUP: Paste your Firebase project config here.
// Get it from: Firebase Console → Project Settings → Your apps → SDK setup
// ─────────────────────────────────────────────────────────────────────────────
const firebaseConfig = {
  apiKey: "AIzaSyAGSBUixXyZ5ztwa_Hq_DtO_XYR3rk5p8M",
  authDomain: "yourtime-chores.firebaseapp.com",
  projectId: "yourtime-chores",
  storageBucket: "yourtime-chores.firebasestorage.app",
  messagingSenderId: "963917934774",
  appId: "1:963917934774:web:aa73030830e33c14b1f617"
};
// ─────────────────────────────────────────────────────────────────────────────

let db = null;
let firestoreUnsubscribe = null;
const FIRESTORE_DOC_PATH = 'chores/state';

/**
 * Initializes Firebase app and starts the Firestore real-time listener.
 */
function initFirebase() {
  try {
    if (!firebase.apps.length) {
      firebase.initializeApp(firebaseConfig);
    }
    db = firebase.firestore();
    updateSyncBadge('syncing', 'Connecting to Firebase...');
    startFirestoreListener();
  } catch (err) {
    console.error('Firebase init error:', err);
    updateSyncBadge('error', 'Firebase init failed: ' + err.message);
  }
}

/**
 * Subscribes to real-time Firestore updates.
 * Automatically merges remote state with local state whenever the cloud document changes.
 */
function startFirestoreListener() {
  if (!db) return;

  // Unsubscribe from any previous listener before starting a new one
  if (firestoreUnsubscribe) firestoreUnsubscribe();

  firestoreUnsubscribe = db.doc(FIRESTORE_DOC_PATH).onSnapshot(
    (docSnap) => {
      if (pendingFirestoreReset) {
        // Version bump: local config has changed (e.g. new rotation order).
        // Overwrite Firestore with fresh local state instead of merging stale cloud data.
        pendingFirestoreReset = false;
        pushToFirestore();
      } else if (docSnap.exists) {
        const remote = docSnap.data();
        mergeStates(remote);
      } else {
        // Document doesn't exist yet — push local state to initialize the cloud
        pushToFirestore();
      }
      updateSyncBadge('success', 'Synced with Firebase');
    },
    (err) => {
      console.error('Firestore listener error:', err);
      updateSyncBadge('error', 'Sync Error: ' + err.message);
    }
  );
}

/**
 * Pushes the current local state (activeTasks + historyLogs) to Firestore.
 * Called after any state-mutating action (complete, undo).
 */
async function pushToFirestore() {
  if (!db) return;
  updateSyncBadge('syncing', 'Saving to Firebase...');
  try {
    await db.doc(FIRESTORE_DOC_PATH).set({
      activeTasks: activeTasks,
      historyLogs: historyLogs,
      lastUpdated: firebase.firestore.FieldValue.serverTimestamp()
    });
    updateSyncBadge('success', 'Synced with Firebase');
  } catch (err) {
    console.error('Firestore push error:', err);
    updateSyncBadge('error', 'Push Failed: ' + err.message);
  }
}

/**
 * Merges remote Firestore state with local state.
 * Uses ID-based deduplication: history takes precedence over active.
 * @param {object} remote - The remote Firestore document data
 */
function mergeStates(remote) {
  // Firestore is the single source of truth for completed history and active tasks.
  // Using a pure remote-wins strategy ensures that undo (moving a task from history
  // back to active) correctly propagates to all devices — the old additive merge
  // would re-complete the task by seeing it in the local history copy.
  const remoteActive = remote.activeTasks || [];
  const remoteHistory = remote.historyLogs || [];

  // Replace with remote state entirely; no additive merge
  historyLogs = remoteHistory;
  activeTasks = remoteActive;

  // Run the scheduler so any newly elapsed intervals are added locally, then push if changed
  const prevCount = activeTasks.length;
  updateState(); // may add newly generated tasks to activeTasks & saves
  if (activeTasks.length !== prevCount) {
    pushToFirestore();
    return; // pushToFirestore triggers another snapshot → renderApp via mergeStates
  }

  saveState();
  renderApp();
}

/**
 * Updates the sync status badge in the header and the Firebase status panel in the sidebar.
 * @param {string} status - 'syncing' | 'success' | 'error' | 'off'
 * @param {string} message - Tooltip / display message
 */
function updateSyncBadge(status, message = '') {
  const badge = document.getElementById('sync-status-badge');
  const text = document.getElementById('sync-status-text');
  const statusDisplay = document.getElementById('firebase-status-display');

  // Header badge
  if (badge) {
    if (status === 'off') {
      badge.style.display = 'none';
    } else {
      badge.style.display = 'inline-flex';
      badge.title = message;
      if (status === 'syncing') {
        badge.style.borderColor = 'var(--status-pending)';
        badge.style.color = 'var(--status-pending)';
        if (text) text.textContent = 'Syncing...';
      } else if (status === 'success') {
        badge.style.borderColor = 'var(--status-green)';
        badge.style.color = 'var(--status-green)';
        if (text) text.textContent = 'Synced \u2713';
      } else if (status === 'error') {
        badge.style.borderColor = 'var(--status-red)';
        badge.style.color = 'var(--status-red)';
        if (text) text.textContent = 'Sync Error';
      }
    }
  }

  // Sidebar Firebase status panel
  if (statusDisplay) {
    const label = message || status;
    if (status === 'syncing') {
      statusDisplay.style.borderColor = 'var(--status-pending)';
      statusDisplay.style.color = 'var(--status-pending)';
      statusDisplay.textContent = '\u23F3 ' + label;
    } else if (status === 'success') {
      statusDisplay.style.borderColor = 'var(--status-green)';
      statusDisplay.style.color = 'var(--status-green)';
      statusDisplay.textContent = '\u2713 ' + label;
    } else if (status === 'error') {
      statusDisplay.style.borderColor = 'var(--status-red)';
      statusDisplay.style.color = 'var(--status-red)';
      statusDisplay.textContent = '\u2715 ' + label;
    } else {
      statusDisplay.style.borderColor = 'var(--border)';
      statusDisplay.style.color = 'var(--text-muted)';
      statusDisplay.textContent = label || 'Disconnected';
    }
  }
}

// --- 7. Event Handlers & Control Listeners ---

document.addEventListener('DOMContentLoaded', () => {
  loadState();

  // Initial task generation and render
  updateState();
  renderApp();

  // Initialize Firebase real-time sync
  initFirebase();

  // Theme Toggle Button
  const themeBtn = document.getElementById('theme-toggle');
  themeBtn.addEventListener('click', () => {
    const htmlEl = document.documentElement;
    const curTheme = htmlEl.getAttribute('data-theme');
    const nextTheme = curTheme === 'dark' ? 'light' : 'dark';

    htmlEl.setAttribute('data-theme', nextTheme);
    localStorage.setItem('theme', nextTheme);
  });

  // Theme Loader
  const storedTheme = localStorage.getItem('theme');
  if (storedTheme) {
    document.documentElement.setAttribute('data-theme', storedTheme);
  }

  // Toggle Dev Sandbox Menu
  const devToggle = document.getElementById('dev-toggle');
  const devClose = document.getElementById('dev-close');
  const devPanel = document.getElementById('dev-panel');

  devToggle.addEventListener('click', () => {
    const show = devPanel.style.display === 'none';
    devPanel.style.display = show ? 'block' : 'none';
  });

  devClose.addEventListener('click', () => {
    devPanel.style.display = 'none';
  });

  // Hook Dev Inputs
  const dateInput = document.getElementById('mock-date-input');
  const timeInput = document.getElementById('mock-time-input');

  function handleDevTimeChange() {
    const dateStr = dateInput.value;
    const timeStr = timeInput.value;
    if (dateStr && timeStr) {
      mockDate = `${dateStr}T${timeStr}:00`;
      localStorage.setItem('yt_mock_date', mockDate);
      updateMockIndicator();
      updateState();
      renderApp();
    }
  }

  dateInput.addEventListener('input', handleDevTimeChange);
  timeInput.addEventListener('input', handleDevTimeChange);

  // Dev Actions
  document.getElementById('dev-today-btn').addEventListener('click', () => {
    mockDate = null;
    localStorage.removeItem('yt_mock_date');

    const current = new Date();
    const isoString = new Date(current.getTime() - current.getTimezoneOffset() * 60000).toISOString();
    dateInput.value = isoString.substring(0, 10);
    timeInput.value = isoString.substring(11, 16);

    updateMockIndicator();
    updateState();
    renderApp();
  });

  document.getElementById('dev-add-day-btn').addEventListener('click', () => {
    const base = getCurrentTime().getTime();
    const nextDate = new Date(base + DAY_MS);
    const offsetIso = new Date(nextDate.getTime() - nextDate.getTimezoneOffset() * 60000).toISOString();

    dateInput.value = offsetIso.substring(0, 10);
    timeInput.value = offsetIso.substring(11, 16);

    handleDevTimeChange();
  });

  document.getElementById('dev-add-week-btn').addEventListener('click', () => {
    const base = getCurrentTime().getTime();
    const nextDate = new Date(base + WEEK_MS);
    const offsetIso = new Date(nextDate.getTime() - nextDate.getTimezoneOffset() * 60000).toISOString();

    dateInput.value = offsetIso.substring(0, 10);
    timeInput.value = offsetIso.substring(11, 16);

    handleDevTimeChange();
  });

  // History Filter listeners
  document.getElementById('history-search').addEventListener('input', renderHistoryTable);
  document.getElementById('history-filter-user').addEventListener('change', renderHistoryTable);
  document.getElementById('history-filter-status').addEventListener('change', renderHistoryTable);

  // Firebase Reconnect Button
  document.getElementById('firebase-reconnect-btn').addEventListener('click', () => {
    if (firestoreUnsubscribe) firestoreUnsubscribe();
    initFirebase();
  });
});