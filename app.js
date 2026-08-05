/* ==========================================================================
   INTERACTIVE APP LOGIC - ASISTENCIAPRO
   ========================================================================== */

// 1. Base de Datos Inicial (Datos por defecto si el LocalStorage está vacío)
const DEFAULT_EMPLOYEES = {
   //"76458278": { name: "HURTADO TORRES GHILBERT ROBERTO", role: "Soporte Técnico", age: 32, gender: "Masculino", pin: "1234", workStart: "08:00", workEnd: "17:00", breakStart: "13:00", breakEnd: "14:00" }
};

// Variable global dinámica que reemplaza a MOCK_EMPLOYEES
let employeesDatabase = {};

// Admin Password
const ADMIN_PASSWORD_HASH = "pc_authorized_g10hvh";

const GLOBAL_FERIADOS = [
  "01/01", "01/05", "29/06", "23/07", "28/07", "29/07", 
  "06/08", "30/08", "08/10", "01/11", "08/12", "09/12", "25/12"
];

function safeSetItem(key, value) {
  try {
    const valStr = (typeof value === 'object') ? JSON.stringify(value) : String(value);
    localStorage.setItem(key, valStr);
  } catch (e) {
    console.error('Error guardando en localStorage:', e);
  }
}

function generateAuthToken(password) {
  let hash = 0;
  for (let i = 0; i < password.length; i++) {
    const char = password.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash = hash & hash;
  }
  return 'pc_authorized_' + Math.abs(hash).toString(36);
}


// State variables
let currentSession = null; 
let attendanceState = {}; 
let globalLogs = []; 
// Auto-sync: intervalos y estado de visibilidad
let autoSyncInterval = null;
const AUTO_SYNC_ADMIN_MS  = 60000;  // Panel Admin: cada 60 segundos
const AUTO_SYNC_AGENT_MS  = 45000;  // Vista Agente: cada 45 segundos
let isSyncing = false;              // Bandera para evitar peticiones solapadas
let googleScriptUrl = "https://script.google.com/macros/s/AKfycbxh-EejSNaokvwz44x-HPemalHWKtnPsq51l4u8YJ1hOZgPJK6LvORA_YpzCoL8lHpKFg/exec";
let googleScriptApiKey = "AsistenciaPro_SecuredKey_2026";

function getScriptUrlWithApiKey(action = '') {
  if (!googleScriptUrl) return '';
  const delimiter = googleScriptUrl.includes('?') ? '&' : '?';
  let url = `${googleScriptUrl}${delimiter}apiKey=${encodeURIComponent(googleScriptApiKey)}&_cb=${new Date().getTime()}`;
  if (action) {
    url += `&action=${encodeURIComponent(action)}`;
  }
  return url;
}

function escapeHtml(str) {
  if (str === null || str === undefined) return '';
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function logDebug(msg, type = 'info') {
  console.log('[DEBUG]', msg);
  const container = document.getElementById('debug-overlay-content');
  if (!container) return;
  const line = document.createElement('div');
  line.style.color = type === 'error' ? '#ff6b6b' : (type === 'warn' ? '#ffd166' : '#06d6a0');
  line.style.marginTop = '3px';
  line.textContent = `> ${new Date().toLocaleTimeString()} ${msg}`;
  container.appendChild(line);
  const parent = document.getElementById('debug-overlay');
  if (parent) parent.scrollTop = parent.scrollHeight;
}

window.onerror = function(msg, url, lineNo, columnNo, error) {
  logDebug(`ERROR: ${msg} (Línea ${lineNo})`, 'error');
  return false;
};

function findEmployeeByDni(dni) {
  if (dni === null || dni === undefined) return null;
  const target = String(dni).replace(/'/g, '').trim();
  if (!target) return null;

  if (employeesDatabase[target]) return employeesDatabase[target];
  if (employeesDatabase[dni]) return employeesDatabase[dni];

  for (const key of Object.keys(employeesDatabase)) {
    const cleanKey = String(key).replace(/'/g, '').trim();
    if (cleanKey === target) {
      return employeesDatabase[key];
    }
    const emp = employeesDatabase[key];
    if (emp && emp.dni && String(emp.dni).replace(/'/g, '').trim() === target) {
      return emp;
    }
  }
  return null;
}

/**
 * Convierte un string de fecha de baja ('YYYY-MM-DD' o 'DD/MM/YYYY') a objeto Date.
 */
function parseFechaBaja(fechaBajaStr) {
  if (!fechaBajaStr) return null;
  let s = String(fechaBajaStr).trim();
  if (s.includes('T')) s = s.split('T')[0];
  
  if (s.includes('/')) {
    const p = s.split('/');
    if (p.length === 3) return new Date(parseInt(p[2], 10), parseInt(p[1], 10) - 1, parseInt(p[0], 10));
  } else if (s.includes('-')) {
    const p = s.split('-');
    if (p.length === 3) return new Date(parseInt(p[0], 10), parseInt(p[1], 10) - 1, parseInt(p[2], 10));
  }
  return null;
}

/**
 * Evalúa si un colaborador debe ser visible en los reportes del mes consultado.
 * Si fue dado de baja, se muestra durante el mes de baja (y meses anteriores), pero NO en el mes siguiente.
 */
function isEmployeeVisibleInMonth(employee, targetMonthIndex, targetYear) {
  if (!employee) return false;
  const est = String(employee.estado || 'Activo').trim().toLowerCase();
  if (est !== 'baja') return true;
  if (!employee.fechaBaja) return false;

  const bajaDate = parseFechaBaja(employee.fechaBaja);
  if (!bajaDate || isNaN(bajaDate.getTime())) return false;

  const bajaMonth = bajaDate.getMonth();
  const bajaYear = bajaDate.getFullYear();

  if (targetYear < bajaYear) return true;
  if (targetYear === bajaYear && targetMonthIndex <= bajaMonth) return true;

  return false;
}

/**
 * Obtiene el estado del colaborador ('ACTIVO' o 'BAJA') para una fecha específica ('DD/MM/YYYY').
 */
function getEmployeeStatusForDate(employee, dateStr) {
  if (!employee) return 'INACTIVO';
  const est = String(employee.estado || 'Activo').trim().toLowerCase();
  if (est !== 'baja') return 'ACTIVO';
  if (!employee.fechaBaja) return 'BAJA';

  const bajaDate = parseFechaBaja(employee.fechaBaja);
  if (!bajaDate || isNaN(bajaDate.getTime())) return 'ACTIVO';

  const parts = dateStr.split('/');
  if (parts.length !== 3) return 'ACTIVO';
  const targetDate = new Date(parseInt(parts[2], 10), parseInt(parts[1], 10) - 1, parseInt(parts[0], 10));

  bajaDate.setHours(0,0,0,0);
  targetDate.setHours(0,0,0,0);

  return targetDate.getTime() >= bajaDate.getTime() ? 'BAJA' : 'ACTIVO';
}

/**
 * Evalúa si un colaborador está activo para la fecha actual o una fecha objetivo.
 */
function isEmployeeActive(employee, targetDateStr = null) {
  if (!employee) return false;
  const est = String(employee.estado || 'Activo').trim().toLowerCase();
  if (est !== 'baja') return true;
  if (!employee.fechaBaja) return false;

  if (targetDateStr) {
    return getEmployeeStatusForDate(employee, targetDateStr) === 'ACTIVO';
  }

  const today = new Date();
  today.setHours(0,0,0,0);
  const bajaDate = parseFechaBaja(employee.fechaBaja);
  if (bajaDate && !isNaN(bajaDate.getTime())) {
    bajaDate.setHours(0,0,0,0);
    return today.getTime() < bajaDate.getTime();
  }
  return false;
}
let tardinessTolerance = 5; 
let cachedAgentHistory = [];
let cachedConsolidatedHistory = []; 
let justificacionesDatabase = [];
let feriadosDatabase = []; 
// Reverted overtimeDatabase, isMarkingCooldown and breakTimerInterval (Puntos 10, 15, 22)

// ... (Las variables de DOM Elements se quedan exactamente igual) ...

// DOM Elements
const views = {
  login: document.getElementById('view-login'),
  dashboard: document.getElementById('view-dashboard'),
  admin: document.getElementById('view-admin')
};

const loginForm = document.getElementById('form-login');
const inputDni = document.getElementById('input-dni');
const inputPin = document.getElementById('input-pin');
const dniError = document.getElementById('dni-error-msg');

const employeeNameText = document.getElementById('employee-name');
const employeeDniDisplay = document.getElementById('employee-dni-display');
const currentStatusText = document.getElementById('current-status-text');
const statusDot = document.querySelector('.status-dot');
const personalLogList = document.getElementById('personal-log-list');

// Attendance Buttons
const btnIngreso = document.getElementById('btn-action-ingreso');
const btnBreakIn = document.getElementById('btn-action-break-in');
const btnBreakOut = document.getElementById('btn-action-break-out');
const btnSalida = document.getElementById('btn-action-salida');
const btnLogout = document.getElementById('btn-logout');

// Admin Elements
const btnAdminToggle = document.getElementById('btn-admin-toggle');
const btnAdminClose = document.getElementById('btn-admin-close');
const adminAuthModal = document.getElementById('admin-auth-modal');
const formAdminAuth = document.getElementById('form-admin-auth');
const inputAdminPassword = document.getElementById('input-admin-password');
const adminErrorMsg = document.getElementById('admin-error-msg');
const btnAdminAuthCancel = document.getElementById('btn-admin-auth-cancel');

// Admin stats and lists
const statTotalStaff = document.getElementById('stat-total-staff');
const statActiveToday = document.getElementById('stat-active-today');
const statInBreak = document.getElementById('stat-in-break');
const adminLiveTableBody = document.getElementById('admin-live-table-body');

// Config elements
const inputSheetUrl = document.getElementById('input-sheet-url');
const btnSaveConfig = document.getElementById('btn-save-config');
const btnTestConnection = document.getElementById('btn-test-connection');
const testConnectionResult = document.getElementById('test-connection-result');
const toastContainer = document.getElementById('toast-container');

// Real-time Clock Elements
const clockTime = document.getElementById('clock-time');
const clockAmpm = document.getElementById('clock-ampm');
const clockDate = document.getElementById('clock-date');

/* ==========================================================================
   INITIALIZATION
   ========================================================================== */

document.addEventListener('DOMContentLoaded', () => {
  initClock();
  loadLocalStorage();
  setupPinpad();
  setupEventListeners();
  updateAdminView();
  initThemeToggle();
  setupAdminTabs();
  setupEditModalListeners();
  setupChangePinModal();
  setupAgentHistoryListeners();
  setupWeeklyScheduleUIListeners();
  setupMonthlyReportUIListeners();
  setupDailySummaryListeners();
  setupDeviceSecurityUIListeners();
  setupGerencialListeners();
  setupValidationsListeners();
  validateDeviceSecurity();
  updatePrintTimestamp();
  syncInitialData().then(() => {
    startAutoSync('admin');
  });
});

/* ==========================================================================
   THEME TOGGLE (CLARO / OSCURO)
   ========================================================================== */

function initThemeToggle() {
  const buttons = document.querySelectorAll('.btn-theme-toggle');
  
  // Load saved preference, default = dark
  const saved = localStorage.getItem('app_theme') || 'dark';
  applyTheme(saved);

  buttons.forEach(btn => {
    btn.addEventListener('click', () => {
      const current = document.documentElement.getAttribute('data-theme') || 'dark';
      const next = current === 'dark' ? 'light' : 'dark';
      applyTheme(next);
      safeSetItem('app_theme', next);
    });
  });
}

function applyTheme(theme) {
  document.documentElement.setAttribute('data-theme', theme);
  const icons = document.querySelectorAll('.theme-icon');
  icons.forEach(iconEl => {
    iconEl.textContent = theme === 'dark' ? 'light_mode' : 'dark_mode';
  });
}

// Load state from LocalStorage to keep simulation persistent
function loadLocalStorage() {
  // Cargar base de datos de empleados
  const savedEmployees = localStorage.getItem('employees_db');
  if (savedEmployees) {
    employeesDatabase = JSON.parse(savedEmployees);
    // Migración: Asegurarse de que todos los empleados tengan horarios
    let needsSave = false;
    Object.keys(employeesDatabase).forEach(dni => {
      if (!employeesDatabase[dni].workStart) {
        employeesDatabase[dni].workStart = "08:00";
        employeesDatabase[dni].workEnd = "17:00";
        employeesDatabase[dni].breakStart = "13:00";
        employeesDatabase[dni].breakEnd = "14:00";
        needsSave = true;
      }
    });
    if (needsSave) {
      safeSetItem('employees_db', JSON.stringify(employeesDatabase));
    }
  } else {
    employeesDatabase = { ...DEFAULT_EMPLOYEES };
    safeSetItem('employees_db', JSON.stringify(employeesDatabase));
  }

  // Asegurar que todos tengan la clave 'dni'
  Object.keys(employeesDatabase).forEach(dni => {
    employeesDatabase[dni].dni = dni;
  });

  // Cargar justificaciones de LocalStorage
  const savedJustificaciones = localStorage.getItem('justificaciones_db');
  if (savedJustificaciones) {
    justificacionesDatabase = JSON.parse(savedJustificaciones);
  } else {
    justificacionesDatabase = [];
  }

  // Cargar feriados de LocalStorage
  const savedFeriados = localStorage.getItem('feriados_db');
  if (savedFeriados) {
    feriadosDatabase = JSON.parse(savedFeriados);
  } else {
    feriadosDatabase = [];
  }

  // Reverted overtime_db loading

  // Cargar estados de asistencia
  const savedState = localStorage.getItem('attendance_state');
  if (savedState) {
    attendanceState = JSON.parse(savedState);
  } else {
    Object.keys(employeesDatabase).forEach(dni => {
      attendanceState[dni] = {
        action: 'Desconectado',
        timestamp: null,
        history: []
      };
    });
    saveState();
  }

  const savedUrl = localStorage.getItem('google_script_url');
  if (savedUrl && savedUrl.trim() !== '') {
    googleScriptUrl = savedUrl.trim();
    const urlInput = document.getElementById('input-sheet-url');
    if (urlInput) urlInput.value = googleScriptUrl;
    const testBtn = document.getElementById('btn-test-connection');
    if (testBtn) testBtn.disabled = false;
  }

  const savedApiKey = localStorage.getItem('google_script_api_key');
  if (savedApiKey && savedApiKey.trim() !== '') {
    googleScriptApiKey = savedApiKey.trim();
  }
  const apiKeyInput = document.getElementById('input-api-key');
  if (apiKeyInput) apiKeyInput.value = googleScriptApiKey;

  // Cargar tolerancia de tardanza
  const savedTolerance = localStorage.getItem('tardiness_tolerance');
  if (savedTolerance !== null) {
    tardinessTolerance = parseInt(savedTolerance, 10);
  } else {
    tardinessTolerance = 5;
  }
  const toleranceInput = document.getElementById('input-tardiness-tolerance');
  if (toleranceInput) {
    toleranceInput.value = tardinessTolerance;
  }
  autoClosePendingSessions();
  loadSecuritySettings();
  validateDeviceSecurity();
}

function saveState() {
  safeSetItem('attendance_state', JSON.stringify(attendanceState));
  safeSetItem('employees_db', JSON.stringify(employeesDatabase));
}

// Reverted saveOvertime

/* ==========================================================================
   CLOCK LÓGICA (RELOJ EN TIEMPO REAL)
   ========================================================================== */

function initClock() {
  const updateClock = () => {
    const now = new Date();
    
    // Formatting Time
    let hours = now.getHours();
    const minutes = String(now.getMinutes()).padStart(2, '0');
    const seconds = String(now.getSeconds()).padStart(2, '0');
    const ampm = hours >= 12 ? 'PM' : 'AM';
    
    hours = hours % 12;
    hours = hours ? hours : 12; // 0 should be 12
    const hoursStr = String(hours).padStart(2, '0');
    
    clockTime.textContent = `${hoursStr}:${minutes}:${seconds}`;
    clockAmpm.textContent = ampm;
    
    // Formatting Date in Spanish
    const options = { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' };
    clockDate.textContent = now.toLocaleDateString('es-ES', options);
  };
  
  updateClock();
  setInterval(updateClock, 1000);
}

/* ==========================================================================
   PINPAD TECLADO VIRTUAL LÓGICA
   ========================================================================== */

function setupPinpad() {
  const pinpadButtons = document.querySelectorAll('.btn-pinpad');
  
  pinpadButtons.forEach(btn => {
    btn.addEventListener('click', () => {
      const val = btn.getAttribute('data-val');
      let currentPin = inputPin.value;
      
      if (val === 'clear') {
        inputPin.value = '';
      } else if (val === 'back') {
        inputPin.value = currentPin.slice(0, -1);
      } else {
        if (currentPin.length < 4) {
          inputPin.value = currentPin + val;
        }
      }
    });
  });
}

/* ==========================================================================
   LOGIN / CERRAR SESIÓN LÓGICA
   ========================================================================== */

loginForm.addEventListener('submit', (e) => {
  e.preventDefault();
  const dni = inputDni.value.trim();
  const pin = inputPin.value;
  
  // Validate DNI in our list
  if (!employeesDatabase[dni]) {
    dniError.classList.remove('hidden');
    showToast('error', 'Error de acceso', 'El DNI ingresado no está registrado.');
    return;
  }
  
  dniError.classList.add('hidden');
  const employee = employeesDatabase[dni];
  
  if (!isEmployeeActive(employee)) {
    showToast('error', 'Acceso Denegado', 'El colaborador se encuentra dado de baja.');
    return;
  }
  
  // Validate Security PIN
  if (employee.pin !== pin) {
    showToast('error', 'PIN incorrecto', 'Por favor ingresa tu código PIN de 4 dígitos válido.');
    return;
  }
  
  // Validar Bloqueo Móvil por Cargo Oficial del DNI en BD
  if (securityBlockMobile && isMobileDevice()) {
    if (isRestrictedMobileRole(employee.role)) {
      showToast(
        'error', 
        'Acceso Móvil Denegado 🚫', 
        `El DNI ${dni} (${employee.name}) tiene registrado el cargo de "${employee.role || 'Colaborador'}". Su cargo solo tiene permitido registrar asistencia desde la PC fija de la oficina.`
      );
      return;
    }
  }

  // Iniciar Sesión Exitosa
  currentSession = {
    dni: dni,
    name: employee.name,
    role: employee.role
  };

  // ── RESET DIARIO ────────────────────────────────────────────
  // Si el último registro fue de un día anterior, reiniciar el estado
  // para que el empleado pueda marcar una nueva jornada hoy.
  const today = new Date().toLocaleDateString('es-ES');
  const empState = attendanceState[dni];
  if (empState && empState.timestamp) {
    const lastDate = new Date(empState.timestamp).toLocaleDateString('es-ES');
    if (lastDate !== today) {
      // Nuevo día: conservar el historial histórico pero resetear estado actual
      attendanceState[dni].action = 'Desconectado';
      attendanceState[dni].timestamp = null;
      // NO vaciamos history para conservar reportes históricos locales!
      saveState();
      showToast('info', 'Nuevo día', 'Estado de marcas reiniciado para hoy.');
    }
  }
  // ────────────────────────────────────────────────────────────

  // Clean inputs
  inputDni.value = '';
  inputPin.value = '';

  showToast('success', 'Bienvenido', `Hola ${employee.name}, has iniciado sesión.`);
  showView('dashboard');
  setupDashboardView();
});

btnLogout.addEventListener('click', () => {
  showToast('info', 'Sesión cerrada', 'Has salido de tu panel de marcas.');
  currentSession = null;
  showView('login');
});

/* ==========================================================================
   EMPLOYEE DASHBOARD INTERFACE CONTROLS
   ========================================================================== */

function handleHistoryFetchResponse(res, fetchStartTime) {
  if (!currentSession) return;
  const dni = currentSession.dni;
  if (res.status === "ok" && Array.isArray(res.data)) {
    const localState = attendanceState[dni] || { action: 'Desconectado', timestamp: null, history: [] };
    
    // Conservar marcas locales que se registraron después de que inició la sincronización
    const newLocalMarks = localState.history.filter(item => item.timestamp >= fetchStartTime);
    
    // Actualizar historial local combinando los registros de la nube y los nuevos locales sin guardar en la nube aún
    attendanceState[dni].history = [...res.data, ...newLocalMarks];
    
    // Solo sobreescribir el estado y timestamp actual si la marca local no fue actualizada en el transcurso
    if (!localState.timestamp || localState.timestamp < fetchStartTime) {
      const todayStr = new Date().toLocaleDateString('es-ES', { day: 'numeric', month: 'numeric', year: 'numeric' });
      const normToday = normalizeDateStr(todayStr);
      const todayMarks = res.data.filter(item => normalizeDateStr(item.dateStr) === normToday);
      
      if (todayMarks.length > 0) {
        todayMarks.sort((a, b) => a.timestamp - b.timestamp);
        const latestMark = todayMarks[todayMarks.length - 1];
        attendanceState[dni].action = latestMark.action;
        attendanceState[dni].timestamp = latestMark.timestamp;
        updateDashboardStatusUI(latestMark.action);
      } else {
        attendanceState[dni].action = 'Desconectado';
        attendanceState[dni].timestamp = null;
        updateDashboardStatusUI('Desconectado');
      }
    }
    
    saveState();
    renderPersonalLogs();
    renderEmployeeWeeklySummary(dni);
    updateAgentGuideAndSchedule();
  }
}

function setupDashboardView() {
  if (!currentSession) return;

  employeeNameText.textContent = currentSession.name;
  employeeDniDisplay.textContent = currentSession.dni;

  // Ensure state exists for this employee
  if (!attendanceState[currentSession.dni]) {
    attendanceState[currentSession.dni] = { action: 'Desconectado', timestamp: null, history: [] };
  }

  const state = attendanceState[currentSession.dni];
  updateDashboardStatusUI(state.action);
  renderPersonalLogs();
  renderEmployeeWeeklySummary(currentSession.dni);
  updateAgentGuideAndSchedule();

  // Iniciar auto-sync en modo agente (liviano, solo su historial)
  startAutoSync('agent');

  // Sincronizar el historial del empleado desde la nube para el resumen semanal y logs
  if (googleScriptUrl) {
    // Deshabilitar botones temporalmente y mostrar estado de carga
    btnIngreso.disabled = true;
    btnBreakIn.disabled = true;
    btnBreakOut.disabled = true;
    btnSalida.disabled = true;
    currentStatusText.textContent = "Sincronizando...";
    currentStatusText.className = 'status-text status-break';
    statusDot.className = 'status-dot pulse status-break';

    const fetchStartTime = Date.now();
    let resolved = false;

    // Timeout de seguridad: 4 segundos
    const syncTimeout = setTimeout(() => {
      if (!resolved) {
        resolved = true;
        showToast('warning', 'Conexión lenta', 'Habilitando marcación local temporal.');
        const localState = attendanceState[currentSession.dni];
        updateDashboardStatusUI(localState ? localState.action : 'Desconectado');
      }
    }, 4000);

    fetch(`${getScriptUrlWithApiKey('get_history')}&dni=${encodeURIComponent(currentSession.dni)}`)
      .then(res => res.json())
      .then(res => {
        if (resolved) return;
        resolved = true;
        clearTimeout(syncTimeout);
        handleHistoryFetchResponse(res, fetchStartTime);
      })
      .catch(err => {
        console.error("Error al sincronizar historial del empleado:", err);
        if (resolved) return;
        resolved = true;
        clearTimeout(syncTimeout);
        const localState = attendanceState[currentSession.dni];
        updateDashboardStatusUI(localState ? localState.action : 'Desconectado');
      });
  }

  // Ocultar botones de break si hoy es día de descanso o "sin break"
  const employee = employeesDatabase[currentSession.dni];
  const dayOfWeek = new Date().getDay(); // 0 = Domingo, 1 = Lunes, etc.
  let todaySched = null;
  if (employee && employee.weeklySchedule) {
    let schedObj = employee.weeklySchedule;
    if (typeof schedObj === 'string' && schedObj.trim() !== '') {
      try {
        schedObj = JSON.parse(schedObj);
      } catch (e) {
        schedObj = null;
      }
    }
    if (schedObj && schedObj[dayOfWeek]) {
      todaySched = schedObj[dayOfWeek];
    }
  }

  if (!todaySched) {
    if (dayOfWeek === 0) todaySched = { isRestDay: true, nobreak: false };
    else todaySched = { isRestDay: false, nobreak: false };
  }

  const breakRow = document.querySelector('.break-actions-row');
  if (breakRow) {
    if (todaySched.isRestDay || todaySched.nobreak) {
      breakRow.style.display = 'none';
    } else {
      breakRow.style.display = 'flex';
    }
  }
}

function updateDashboardStatusUI(action) {
  currentStatusText.textContent = action;
  
  // Remove existing color classes
  currentStatusText.className = 'status-text';
  statusDot.className = 'status-dot pulse';

  // Add appropriate colors and manage buttons state
  switch(action) {
    case 'Ingreso':
      currentStatusText.textContent = 'Conectado (Trabajando)';
      currentStatusText.classList.add('status-active');
      statusDot.classList.add('status-active');
      
      btnIngreso.disabled = true;
      btnBreakIn.disabled = false;
      btnBreakOut.disabled = true;
      btnSalida.disabled = false;
      break;
      
    case 'Inicio Refrigerio':
      currentStatusText.textContent = 'En Refrigerio (Almuerzo)';
      currentStatusText.classList.add('status-break');
      statusDot.classList.add('status-break');
      
      btnIngreso.disabled = true;
      btnBreakIn.disabled = true;
      btnBreakOut.disabled = false;
      btnSalida.disabled = false;
      break;
      
    case 'Fin Refrigerio':
      currentStatusText.textContent = 'Conectado (Trabajando)';
      currentStatusText.classList.add('status-active');
      statusDot.classList.add('status-active');
      
      btnIngreso.disabled = true;
      btnBreakIn.disabled = true; // Typically one break per day, but can be adjusted
      btnBreakOut.disabled = true;
      btnSalida.disabled = false;
      break;
      
    case 'Salida':
      currentStatusText.textContent = 'Jornada Finalizada (Salida)';
      currentStatusText.classList.add('status-inactive');
      statusDot.classList.add('status-inactive');
      
      btnIngreso.disabled = true;
      btnBreakIn.disabled = true;
      btnBreakOut.disabled = true;
      btnSalida.disabled = true;
      break;
      
    default:
      currentStatusText.textContent = 'Fuera de Jornada';
      btnIngreso.disabled = false;
      btnBreakIn.disabled = true;
      btnBreakOut.disabled = true;
      btnSalida.disabled = true;
      
      // Bloquear ingreso si es feriado, día de descanso o si ya pasó la hora de fin de jornada
      if (currentSession && employeesDatabase[currentSession.dni]) {
        const employee = employeesDatabase[currentSession.dni];
        const todayDate = new Date();
        const normToday = getTodayNormalizedDateStr(todayDate);
        const partsToday = normToday.split('/');
        const dayMonthToday = `${partsToday[0].padStart(2, '0')}/${partsToday[1].padStart(2, '0')}`;
        
        const isStaticHoliday = GLOBAL_FERIADOS.includes(dayMonthToday);
        const customHoliday = feriadosDatabase.find(f => normalizeDateStr(f.dateStr) === normToday);
        const isHoliday = isStaticHoliday || !!customHoliday;

        const dayOfWeek = todayDate.getDay(); // 0 = Domingo, 1 = Lunes...
        let todaySched = null;
        if (employee && employee.weeklySchedule) {
          let schedObj = employee.weeklySchedule;
          if (typeof schedObj === 'string' && schedObj.trim() !== '') {
            try { schedObj = JSON.parse(schedObj); } catch (e) {}
          }
          if (schedObj && schedObj[dayOfWeek]) {
            todaySched = schedObj[dayOfWeek];
          }
        }
        if (!todaySched) {
          if (dayOfWeek === 0) todaySched = { isRestDay: true };
          else todaySched = { isRestDay: false, workEnd: employee.workEnd || "17:00" };
        }

        const isRestDay = !!todaySched.isRestDay;

        if (isHoliday) {
          btnIngreso.disabled = true;
          btnIngreso.title = "Hoy es día feriado oficial. No está permitido marcar ingreso.";
          currentStatusText.textContent = 'Día Feriado Oficial (Sin Marcación)';
        } else if (isRestDay) {
          btnIngreso.disabled = true;
          btnIngreso.title = "Hoy es tu día de descanso programado. No está permitido marcar ingreso.";
          currentStatusText.textContent = 'Día de Descanso (No Programado)';
        } else {
          const workEndStr = todaySched.workEnd || "17:00";
          const [endHour, endMin] = workEndStr.split(':').map(Number);
          const endSeconds = (endHour * 3600) + (endMin * 60);
          
          const nowHour = todayDate.getHours();
          const nowMin = todayDate.getMinutes();
          const nowSec = todayDate.getSeconds();
          const nowSeconds = (nowHour * 3600) + (nowMin * 60) + nowSec;
          
          if (nowSeconds >= endSeconds) {
            btnIngreso.disabled = true;
            btnIngreso.title = "No puede marcar ingreso fuera de su jornada.";
            currentStatusText.textContent = 'Fuera de Jornada (Horario Finalizado)';
          }
        }
      }
      break;
  }
}

// Render recent marks for the current employee (only for today)
function renderPersonalLogs() {
  personalLogList.innerHTML = '';
  const allHistory = attendanceState[currentSession.dni].history || [];
  const todayStr = new Date().toLocaleDateString('es-ES', { day: 'numeric', month: 'numeric', year: 'numeric' });
  const normToday = normalizeDateStr(todayStr);
  const history = allHistory.filter(item => normalizeDateStr(item.dateStr) === normToday);
  
  if (history.length === 0) {
    personalLogList.innerHTML = '<li class="log-empty">No has registrado marcas el día de hoy.</li>';
    return;
  }
  
  // Sort history newest first
  const sortedHistory = [...history].reverse();
  
  sortedHistory.forEach(item => {
    const li = document.createElement('li');
    li.className = 'log-item animate-fade-in';
    
    let iconName = 'timer';
    let label = item.action;
    let iconClass = item.action.replace(' ', '_');
    
    if (item.action === 'Ingreso') iconName = 'play_arrow';
    else if (item.action === 'Salida') iconName = 'stop';
    else if (item.action === 'Inicio Refrigerio') {
      iconName = 'restaurant';
      label = 'Inicio Refrigerio';
    }
    else if (item.action === 'Fin Refrigerio') {
      iconName = 'restaurant_menu';
      label = 'Fin Refrigerio';
    }
    
    li.innerHTML = `
      <div class="log-info">
        <div class="log-icon ${iconClass}">
          <span class="material-symbols-rounded">${iconName}</span>
        </div>
        <div class="log-content">
          <h4>${label}</h4>
          <p>${item.dateStr}</p>
        </div>
      </div>
      <div class="log-time">${item.timeStr}</div>
    `;
    personalLogList.appendChild(li);
  });
}
// Function to log attendance action
function registerAttendanceAction(action) {
  if (!currentSession) return;
  
  const dni = currentSession.dni;
  const name = currentSession.name;
  const now = new Date();

  // PREVENCIÓN DE DOBLE MARCACIÓN
  const empState = attendanceState[dni];
  if (empState && Array.isArray(empState.history)) {
    // 1. Evitar marcaciones de cualquier tipo en menos de 5 segundos
    const lastAnyMark = empState.history[empState.history.length - 1];
    if (lastAnyMark && (now.getTime() - lastAnyMark.timestamp) < 5000) {
      showToast('warning', 'Espera un momento', 'Procesando tu marcación anterior. Por favor espera.');
      return;
    }

    // 2. Evitar marcaciones de la misma acción en menos de 60 segundos
    const lastMarkOfSameAction = empState.history.find(item => 
      item.action === action && 
      (now.getTime() - item.timestamp) < 60000
    );
    if (lastMarkOfSameAction) {
      showToast('warning', 'Marcación duplicada bloqueada 🛑', `Ya registraste tu ${action} hace menos de un minuto.`);
      return;
    }
  }
  
  const timeStr = now.toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  const dateStr = now.toLocaleDateString('es-ES', { day: 'numeric', month: 'numeric', year: 'numeric' });
  
  // ESCENARIO 1: Si marca Salida pero no cerró el break (Inicio Refrigerio)
  if (action === 'Salida' && attendanceState[dni] && attendanceState[dni].action === 'Inicio Refrigerio') {
    const preTime = new Date(now.getTime() - 1000);
    const preTimeStr = preTime.toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    const preDateStr = preTime.toLocaleDateString('es-ES', { day: 'numeric', month: 'numeric', year: 'numeric' });
    
    const preLogItem = {
      action: 'Fin Refrigerio',
      timestamp: preTime.getTime(),
      timeStr: preTimeStr,
      dateStr: preDateStr,
      details: 'Autocompletado por omisión',
      device: 'Sistema'
    };
    
    attendanceState[dni].action = 'Fin Refrigerio';
    attendanceState[dni].timestamp = preTime.getTime();
    attendanceState[dni].history.push(preLogItem);
    
    if (googleScriptUrl) {
      sendAttendanceToGoogleSheets(dni, name, 'Fin Refrigerio', preTime);
    }
  }

  const logItem = {
    action: action,
    timestamp: now.getTime(),
    timeStr: timeStr,
    dateStr: dateStr,
    device: obtenerDispositivo()
  };
  
  // 1. Update State Locally
  attendanceState[dni].action = action;
  attendanceState[dni].timestamp = now.getTime();
  attendanceState[dni].history.push(logItem);
  saveState();
  
  // 2. Trigger real integration if Apps Script URL is configured!
  if (googleScriptUrl) {
    sendAttendanceToGoogleSheets(dni, name, action);
  } else {
    showToast('success', 'Marca registrada localmente', `${action} registrado a las ${timeStr}`);
  }
  
  // 3. Update UI
  updateDashboardStatusUI(action);
  renderPersonalLogs();
  renderEmployeeWeeklySummary(dni);
  updateAgentGuideAndSchedule();
  updateAdminView();

}
// Enviar nuevo empleado a Google Sheets
function sendRegistrationToGoogleSheets(dni, name, age, gender, role, workStart, workEnd, breakStart, breakEnd, pin = "1234", weeklySchedule = "") {
  // Si no hay URL de Sheet configurada, no hace nada
  if (!googleScriptUrl) return; 

  showToast('warning', 'Sincronizando...', 'Guardando nuevo personal en Google Sheets.');
  
  const payload = {
    action: "Registrar_Personal", // Acción específica para que tu Sheet sepa qué hacer
    apiKey: googleScriptApiKey,
    employeeId: dni,
    employeeName: name,
    age: age,
    gender: gender,
    role: role,
    workStart: workStart,
    workEnd: workEnd,
    breakStart: breakStart,
    breakEnd: breakEnd,
    pin: pin,
    weeklySchedule: typeof weeklySchedule === 'object' ? JSON.stringify(weeklySchedule) : weeklySchedule
  };
  
  fetch(getScriptUrlWithApiKey(), {
    method: 'POST',
    mode: 'no-cors',
    headers: {
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(payload)
  })
  .then(() => {
    showToast('success', 'Guardado en la Nube ☁️', `${name} se guardó en tu Google Sheet.`);
  })
  .catch(err => {
    console.error('Error guardando personal:', err);
    showToast('error', 'Error de Nube', 'No se pudo guardar en el Sheet. Se guardó localmente.');
  });
}

// Sincronizar edición de empleado en Google Sheets
function sendUpdateToGoogleSheets(dni, name, role, workStart, workEnd, breakStart, breakEnd, pin, weeklySchedule = "", estado = "Activo", fechaBaja = "") {
  if (!googleScriptUrl) return;

  const employee = employeesDatabase[dni] || {};
  const age = employee.age || "—";
  const gender = employee.gender || "—";
  const finalPin = pin || employee.pin || "1234";

  showToast('warning', 'Sincronizando...', 'Actualizando horarios en Google Sheets.');
  
  const payload = {
    action: "Editar_Personal",
    apiKey: googleScriptApiKey,
    employeeId: dni,
    employeeName: name,
    age: age,
    gender: gender,
    role: role,
    workStart: workStart,
    workEnd: workEnd,
    breakStart: breakStart,
    breakEnd: breakEnd,
    pin: finalPin,
    weeklySchedule: typeof weeklySchedule === 'object' ? JSON.stringify(weeklySchedule) : weeklySchedule,
    estado: estado,
    fechaBaja: fechaBaja
  };
  
  fetch(getScriptUrlWithApiKey(), {
    method: 'POST',
    mode: 'no-cors',
    headers: {
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(payload)
  })
  .then(() => {
    showToast('success', 'Nube Actualizada ☁️', `${name} se actualizó en tu Google Sheet.`);
  })
  .catch(err => {
    console.error('Error actualizando personal:', err);
    showToast('error', 'Error de Nube', 'No se pudo actualizar en el Sheet.');
  });
}

// Sincronizar la base de datos de colaboradores desde el Google Sheets
function syncEmployeesFromGoogleSheets() {
  if (!googleScriptUrl) return Promise.resolve();
  
  return fetch(getScriptUrlWithApiKey('get_employees'))
    .then(res => res.json())
    .then(res => {
      if (res.status === "ok" && Array.isArray(res.data)) {
        employeesDatabase = {};
        res.data.forEach(emp => {
          // Parsear weeklySchedule
          let parsedWeekly = null;
          if (emp.weeklySchedule) {
            if (emp.weeklySchedule === 'flexible') {
              parsedWeekly = 'flexible';
            } else {
              try {
                parsedWeekly = typeof emp.weeklySchedule === 'string' ? JSON.parse(emp.weeklySchedule) : emp.weeklySchedule;
              } catch (e) {
                parsedWeekly = null;
              }
            }
          }

          // Si el colaborador ya existe, actualizar todos sus datos (incluyendo PIN)
          // Si no existe, crearlo
          employeesDatabase[emp.dni] = {
            dni: emp.dni,
            name: emp.name,
            role: emp.role,
            age: emp.age,
            gender: emp.gender,
            pin: emp.pin || "1234",
            workStart: emp.workStart || "08:00",
            workEnd: emp.workEnd || "17:00",
            breakStart: emp.breakStart || "13:00",
            breakEnd: emp.breakEnd || "14:00",
            weeklySchedule: parsedWeekly,
            estado: emp.estado || "Activo",
            fechaBaja: emp.fechaBaja || ""
          };
          
          // Asegurarse de que tenga estado de asistencia básico si no existía
          if (!attendanceState[emp.dni]) {
            attendanceState[emp.dni] = {
              action: 'Desconectado',
              timestamp: null,
              history: []
            };
          }
        });
        
        saveState();
        updateAdminView();
        updateReportEmployeeSelect();
        console.log("Colaboradores sincronizados desde Google Sheets.");
      }
    })
    .catch(err => {
      console.error("Error al sincronizar colaboradores desde Google Sheets:", err);
    });
}

// Sincronizar todos los estados de asistencia basados en el historial completo de Google Sheets
function syncAllAttendanceStatesFromHistory() {
  if (!googleScriptUrl) return Promise.resolve();
  return fetchAllHistoryFromGoogleSheets()
    .then(history => {
      if (!history || !Array.isArray(history)) return;
      
      attendanceState = {};
      // Inicializar el historial vacío de todos los empleados
      Object.keys(employeesDatabase).forEach(dni => {
        if (!attendanceState[dni]) {
          attendanceState[dni] = { action: 'Desconectado', timestamp: null, history: [] };
        } else {
          attendanceState[dni].history = [];
        }
      });
      
      // Agrupar marcas del historial por DNI
      history.forEach(item => {
        const dni = item.dni;
        if (dni && attendanceState[dni]) {
          const exists = attendanceState[dni].history.some(h => 
            h.timestamp === item.timestamp && h.action === item.action
          );
          if (!exists) {
            attendanceState[dni].history.push(item);
          }
        }
      });
      
      // Reconstruir el estado (action y timestamp) para hoy
      const todayStr = new Date().toLocaleDateString('es-ES', { day: 'numeric', month: 'numeric', year: 'numeric' });
      const normToday = normalizeDateStr(todayStr);
      
      Object.keys(employeesDatabase).forEach(dni => {
        const todayMarks = attendanceState[dni].history.filter(item => 
          normalizeDateStr(item.dateStr) === normToday
        );
        
        if (todayMarks.length > 0) {
          todayMarks.sort((a, b) => a.timestamp - b.timestamp);
          const latestMark = todayMarks[todayMarks.length - 1];
          attendanceState[dni].action = latestMark.action;
          attendanceState[dni].timestamp = latestMark.timestamp;
        } else {
          attendanceState[dni].action = 'Desconectado';
          attendanceState[dni].timestamp = null;
        }
      });
      
      saveState();
      updateAdminView();
      console.log("Estados de asistencia reconstruidos desde historial de la nube.");
    })
    .catch(err => {
      console.error("Error reconstruyendo estados de asistencia desde el historial:", err);
    });
}

// Sincronización consolidada/unificada en una sola petición
// ── AUTO-SYNC INTELIGENTE ──────────────────────────────────────────────────
// Sincronización automática en segundo plano, sin saturar y respetando visibilidad de la página

function startAutoSync(mode) {
  stopAutoSync(); // Limpiar cualquier intervalo previo
  if (!googleScriptUrl) return;

  const delay = (mode === 'agent') ? AUTO_SYNC_AGENT_MS : AUTO_SYNC_ADMIN_MS;

  autoSyncInterval = setInterval(() => {
    // No sincronizar si la pestaña está oculta (ahorrar ancho de banda)
    if (document.hidden) return;
    // No solapar peticiones en curso
    if (isSyncing) return;

    isSyncing = true;

    if (mode === 'agent' && currentSession) {
      const fetchStartTime = Date.now();
      // MODO AGENTE: solo trae el historial del agente logueado (liviano)
      fetch(`${getScriptUrlWithApiKey('get_history')}&dni=${encodeURIComponent(currentSession.dni)}`)
        .then(res => res.json())
        .then(res => {
          handleHistoryFetchResponse(res, fetchStartTime);
        })
        .catch(() => {})
        .finally(() => { isSyncing = false; });

    } else if (mode === 'admin') {
      // MODO ADMIN: sincronización completa pero silenciosa
      syncInitialData()
        .then(() => {
          // Refrescar la vista del admin sin hacer scroll ni mostrar toast
          updateAdminView();

          // Si hay una pestaña de reporte o consolidado activa, recargarla también
          const activeTab = document.querySelector('.tab-btn.active');
          if (activeTab) {
            const tabId = activeTab.getAttribute('data-tab');
            if (tabId === 'reports') {
              const select = document.getElementById('select-report-employee');
              if (select && select.value) {
                const emp = (select.value === 'all') ? 'all' : employeesDatabase[select.value];
                if (emp) renderReportTable(cachedAgentHistory, emp);
              }
            } else if (tabId === 'consolidated') {
              renderConsolidatedTable(cachedConsolidatedHistory);
            }
          }
        })
        .catch(() => {})
        .finally(() => { isSyncing = false; });
    } else {
      isSyncing = false;
    }
  }, delay);

  console.log(`Auto-sync iniciado en modo "${mode}" cada ${delay / 1000}s.`);
}

function stopAutoSync() {
  if (autoSyncInterval) {
    clearInterval(autoSyncInterval);
    autoSyncInterval = null;
  }
}

function syncInitialData() {
  if (!googleScriptUrl) return Promise.resolve();
  
  console.log("Iniciando sincronización unificada...");
  updateCloudStatus('syncing');
  
  return fetch(getScriptUrlWithApiKey('get_initial_data'))
    .then(res => res.json())
    .then(res => {
      if (res.status === "ok" && res.data) {
        const { employees, justificaciones, feriados, history, config } = res.data;
        
        // 0. Cargar y aplicar configuración global de seguridad
        if (config) {
          if (typeof config.security_block_mobile === 'boolean') {
            securityBlockMobile = config.security_block_mobile;
            safeSetItem('security_block_mobile', securityBlockMobile);
          }
          if (typeof config.security_restrict_pcs === 'boolean') {
            securityRestrictPcs = config.security_restrict_pcs;
            safeSetItem('security_restrict_pcs', securityRestrictPcs);
          }
          if (typeof config.tardiness_tolerance === 'number' && config.tardiness_tolerance >= 0) {
            tardinessTolerance = config.tardiness_tolerance;
            safeSetItem('tardiness_tolerance', tardinessTolerance);
          }
          const chkMobile = document.getElementById('chk-block-mobile');
          const chkPcs = document.getElementById('chk-restrict-pcs');
          if (chkMobile) chkMobile.checked = securityBlockMobile;
          if (chkPcs) chkPcs.checked = securityRestrictPcs;
          validateDeviceSecurity();
        }

        // 1. Cargar colaboradores
        if (Array.isArray(employees)) {
          employeesDatabase = {};
          attendanceState = {};
          employees.forEach(emp => {
            let parsedWeekly = null;
            if (emp.weeklySchedule) {
              if (emp.weeklySchedule === 'flexible') {
                parsedWeekly = 'flexible';
              } else {
                try { 
                  parsedWeekly = typeof emp.weeklySchedule === 'string' ? JSON.parse(emp.weeklySchedule) : emp.weeklySchedule; 
                } catch(e) {
                  parsedWeekly = null;
                }
              }
            }
            employeesDatabase[emp.dni] = {
              dni: emp.dni,
              name: emp.name,
              role: emp.role,
              age: emp.age,
              gender: emp.gender,
              pin: emp.pin || "1234",
              workStart: emp.workStart || "08:00",
              workEnd: emp.workEnd || "17:00",
              breakStart: emp.breakStart || "13:00",
              breakEnd: emp.breakEnd || "14:00",
              weeklySchedule: parsedWeekly,
              estado: emp.estado || "Activo",
              fechaBaja: emp.fechaBaja || ""
            };
            if (!attendanceState[emp.dni]) {
              attendanceState[emp.dni] = { action: 'Desconectado', timestamp: null, history: [] };
            }
          });
        }
        
        // 2. Cargar justificaciones
        if (Array.isArray(justificaciones)) {
          justificacionesDatabase = justificaciones;
        }
        
        // 3. Cargar feriados
        if (Array.isArray(feriados)) {
          feriadosDatabase = feriados;
        }
        
        // 4. Cargar e integrar historial
        if (Array.isArray(history)) {
          Object.keys(employeesDatabase).forEach(dni => {
            if (!attendanceState[dni]) {
              attendanceState[dni] = { action: 'Desconectado', timestamp: null, history: [] };
            } else {
              attendanceState[dni].history = [];
            }
          });
          
          history.forEach(item => {
            const dni = item.dni;
            if (dni && attendanceState[dni]) {
              const exists = attendanceState[dni].history.some(h => 
                h.timestamp === item.timestamp && h.action === item.action
              );
              if (!exists) {
                attendanceState[dni].history.push(item);
              }
            }
          });
          
          const normToday = getTodayNormalizedDateStr();
          
          Object.keys(employeesDatabase).forEach(dni => {
            const todayMarks = attendanceState[dni].history.filter(item => 
              normalizeDateStr(item.dateStr) === normToday
            );
            if (todayMarks.length > 0) {
              todayMarks.sort((a, b) => a.timestamp - b.timestamp);
              const latestMark = todayMarks[todayMarks.length - 1];
              attendanceState[dni].action = latestMark.action;
              attendanceState[dni].timestamp = latestMark.timestamp;
            } else {
              attendanceState[dni].action = 'Desconectado';
              attendanceState[dni].timestamp = null;
            }
          });
        }
        
        autoClosePendingSessions();
        saveState();
        updateAdminView();
        updateReportEmployeeSelect();
        if (typeof renderValidationsView === 'function') renderValidationsView();
        console.log("Sincronización unificada completada con éxito.");
        updateCloudStatus('connected');
      } else {
        throw new Error("Formato de respuesta incorrecto");
      }
    })
    .catch(err => {
      console.warn("Fallo la sincronización unificada. Usando fallback individual...", err);
      updateCloudStatus('syncing');
      return syncEmployeesFromGoogleSheets().then(() => {
        syncJustificacionesFromGoogleSheets();
        syncFeriadosFromGoogleSheets();
        syncAllAttendanceStatesFromHistory();
        updateCloudStatus('connected');
      }).catch(fallbackErr => {
        updateCloudStatus('error');
        throw fallbackErr;
      });
    });
}

// Configurar el Modal de Cambio de PIN para los empleados
function setupChangePinModal() {
  const btnTrigger = document.getElementById('btn-change-pin-trigger');
  const modal = document.getElementById('modal-change-pin');
  const form = document.getElementById('form-change-pin');
  const btnCancel = document.getElementById('btn-change-pin-cancel');
  const errorMsg = document.getElementById('change-pin-error-msg');

  if (!btnTrigger || !modal || !form || !btnCancel) return;

  btnTrigger.addEventListener('click', () => {
    modal.classList.remove('hidden');
    form.reset();
    errorMsg.classList.add('hidden');
  });

  btnCancel.addEventListener('click', () => {
    modal.classList.add('hidden');
  });

  form.addEventListener('submit', (e) => {
    e.preventDefault();
    errorMsg.classList.add('hidden');

    const currentPin = document.getElementById('change-pin-current').value.trim();
    const newPin = document.getElementById('change-pin-new').value.trim();
    const confirmPin = document.getElementById('change-pin-confirm').value.trim();

    if (!currentSession || !currentSession.dni) {
      showToast('error', 'Error', 'No hay sesión de colaborador activa.');
      return;
    }

    const dni = currentSession.dni;
    const employee = employeesDatabase[dni];

    if (!employee) {
      showToast('error', 'Error', 'El colaborador no existe en la base de datos.');
      return;
    }

    // Validar PIN actual
    if (employee.pin !== currentPin) {
      errorMsg.textContent = 'El PIN actual es incorrecto.';
      errorMsg.classList.remove('hidden');
      return;
    }

    // Validar coincidencia de PIN nuevo
    if (newPin !== confirmPin) {
      errorMsg.textContent = 'Los nuevos PINs no coinciden.';
      errorMsg.classList.remove('hidden');
      return;
    }

    // Validar longitud
    if (newPin.length !== 4 || isNaN(parseInt(newPin, 10))) {
      errorMsg.textContent = 'El nuevo PIN debe ser un número de 4 dígitos.';
      errorMsg.classList.remove('hidden');
      return;
    }

    // Cambiar PIN
    employee.pin = newPin;
    saveState();

    // Enviar cambio a Google Sheets
    if (googleScriptUrl) {
      sendUpdateToGoogleSheets(dni, employee.name, employee.role, employee.workStart, employee.workEnd, employee.breakStart, employee.breakEnd, newPin);
    }

    modal.classList.add('hidden');
    showToast('success', 'PIN Cambiado ✅', 'Tu PIN de seguridad se actualizó correctamente.');
  });
}
/* ==========================================================================
   ATTENDANCE RECORDING ACTIONS (MARCAR ASISTENCIA LÓGICA)
   ========================================================================== */

function setupEventListeners() {
  const attendanceButtons = [btnIngreso, btnBreakIn, btnBreakOut, btnSalida];
  
  attendanceButtons.forEach(btn => {
    btn.addEventListener('click', async () => {
      const action = btn.getAttribute('data-action');
      const dni = currentSession ? currentSession.dni : null;
      const employee = dni ? employeesDatabase[dni] : null;

      // Restricción en Feriados, Días de Descanso e Ingreso Anticipado para 'Ingreso'
      if (action === 'Ingreso' && employee) {
        const now = new Date();
        const normToday = getTodayNormalizedDateStr(now);
        const partsToday = normToday.split('/');
        const dayMonthToday = `${partsToday[0].padStart(2, '0')}/${partsToday[1].padStart(2, '0')}`;
        
        const isStaticHoliday = GLOBAL_FERIADOS.includes(dayMonthToday);
        const customHoliday = feriadosDatabase.find(f => normalizeDateStr(f.dateStr) === normToday);
        const isHoliday = isStaticHoliday || !!customHoliday;

        if (isHoliday) {
          showToast('warning', 'Día Feriado Oficial', 'Hoy es un día feriado oficial. No está permitido registrar ingreso.');
          return;
        }

        const dayOfWeek = now.getDay();
        let todaySched = null;

        if (employee.weeklySchedule) {
          let schedObj = employee.weeklySchedule;
          if (typeof schedObj === 'string' && schedObj.trim() !== '') {
            try { schedObj = JSON.parse(schedObj); } catch (e) { schedObj = null; }
          }
          if (schedObj && schedObj[dayOfWeek]) {
            todaySched = schedObj[dayOfWeek];
          }
        }

        if (!todaySched) {
          if (dayOfWeek === 0) todaySched = { isRestDay: true };
          else if (dayOfWeek === 6) todaySched = { isRestDay: false, workStart: employee.workStart || "09:00" };
          else todaySched = { isRestDay: false, workStart: employee.workStart || "08:00" };
        }

        if (todaySched && todaySched.isRestDay) {
          showToast('warning', 'Día de Descanso', 'Hoy es tu día de descanso programado. No está permitido registrar ingreso.');
          return;
        }

        const isFlexible = (employee.workStart === "—" || employee.weeklySchedule === "flexible");
        if (!isFlexible) {

          if (todaySched && !todaySched.isRestDay) {
            const startStr = todaySched.workStart || "08:00";
            const [startHour, startMin] = startStr.split(':').map(Number);
            const startSeconds = (startHour * 3600) + (startMin * 60);

            const nowHour = now.getHours();
            const nowMin = now.getMinutes();
            const nowSec = now.getSeconds();
            const nowSeconds = (nowHour * 3600) + (nowMin * 60) + nowSec;

            // Bloquear si intenta ingresar antes de la hora programada menos 5 minutos (300 segundos)
            const earliestAllowedSeconds = startSeconds - 300;
            if (nowSeconds < earliestAllowedSeconds) {
              const diffMin = Math.ceil((earliestAllowedSeconds - nowSeconds) / 60);
              const earliestHour = Math.floor(earliestAllowedSeconds / 3600);
              const earliestMin = Math.floor((earliestAllowedSeconds % 3600) / 60);
              const earliestStr = `${String(earliestHour).padStart(2, '0')}:${String(earliestMin).padStart(2, '0')}`;
              
              showToast('error', 'Marcación anticipada bloqueada', `Solo puedes registrar tu ingreso a partir de las ${earliestStr} (5 min antes del turno). Faltan ${diffMin} min.`);
              return;
            }
          }
        }
      } else {
        // Ventana Flotante de Confirmación para Inicio Break, Fin Break y Salida
        const now = new Date();
        const timeStr = now.toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit' });

        let confirmConfig = null;
        if (action === 'Inicio Refrigerio') {
          confirmConfig = {
            title: 'Confirmar Inicio de Refrigerio 🥪',
            message: `¿Estás seguro de que deseas registrar tu <strong>Inicio de Break</strong> a las <strong>${timeStr}</strong>?`,
            type: 'warning',
            acceptText: 'Sí, Iniciar Break',
            cancelText: 'Cancelar'
          };
        } else if (action === 'Fin Refrigerio') {
          confirmConfig = {
            title: 'Confirmar Fin de Refrigerio ☕',
            message: `¿Estás seguro de que deseas registrar tu <strong>Fin de Break</strong> a las <strong>${timeStr}</strong>?`,
            type: 'info',
            acceptText: 'Sí, Finalizar Break',
            cancelText: 'Cancelar'
          };
        } else if (action === 'Salida') {
          confirmConfig = {
            title: 'Confirmar Salida de Jornada 🚪',
            message: `¿Estás seguro de que deseas registrar tu <strong>Salida de Jornada</strong> a las <strong>${timeStr}</strong>?`,
            type: 'danger',
            acceptText: 'Sí, Registrar Salida',
            cancelText: 'Cancelar'
          };
        }

        if (confirmConfig) {
          const confirmed = await showCustomConfirm(confirmConfig);
          if (!confirmed) return; // Si el colaborador cancela, detiene el proceso de marcación
        }
      }

      registerAttendanceAction(action);
    });
  });
  
  // Admin button triggers modal
  btnAdminToggle.addEventListener('click', () => {
    adminAuthModal.classList.remove('hidden');
    inputAdminPassword.focus();
  });
  
  btnAdminAuthCancel.addEventListener('click', () => {
    adminAuthModal.classList.add('hidden');
    inputAdminPassword.value = '';
    adminErrorMsg.classList.add('hidden');
  });
  
  // Admin login form submit
  formAdminAuth.addEventListener('submit', (e) => {
    e.preventDefault();
    const password = inputAdminPassword.value;
    
    if (generateAuthToken(password) === ADMIN_PASSWORD_HASH) {
      adminAuthModal.classList.add('hidden');
      inputAdminPassword.value = '';
      adminErrorMsg.classList.add('hidden');
      showToast('success', 'Admin autenticado', 'Bienvenido al panel de control general.');
      showView('admin');
      updateAdminView();
      
      const savedUrl = localStorage.getItem('google_script_url');
      if (savedUrl && savedUrl.trim() !== '' && inputSheetUrl) {
        inputSheetUrl.value = savedUrl;
        googleScriptUrl = savedUrl;
        btnTestConnection.disabled = false;
      } else if (!googleScriptUrl) {
        googleScriptUrl = "https://script.google.com/macros/s/AKfycbxh-EejSNaokvwz44x-HPemalHWKtnPsq51l4u8YJ1hOZgPJK6LvORA_YpzCoL8lHpKFg/exec";
      }
      
      // Sincronización asíncrona en segundo plano (0ms de retraso en la interfaz)
      setTimeout(() => {
        syncInitialData();
      }, 50);

    } else {
      adminErrorMsg.classList.remove('hidden');
      inputAdminPassword.value = '';
      showToast('error', 'Acceso denegado', 'La contraseña de administrador es incorrecta.');
    }
  });
  
  btnAdminClose.addEventListener('click', () => {
    showView(currentSession ? 'dashboard' : 'login');
  });
  
  // Configuration save button
  btnSaveConfig.addEventListener('click', () => {
    const url = (inputSheetUrl.value || '').trim();
    const toleranceInput = document.getElementById('input-tardiness-tolerance');
    
    if (toleranceInput) {
      const tolVal = parseInt(toleranceInput.value, 10);
      if (!isNaN(tolVal) && tolVal >= 0) {
        tardinessTolerance = tolVal;
        safeSetItem('tardiness_tolerance', tardinessTolerance);
      }
    }

    let urlMessage = "";
    if (url === '') {
      googleScriptUrl = '';
      localStorage.removeItem('google_script_url');
      btnTestConnection.disabled = true;
      urlMessage = 'Se removió el enlace de Google Apps Script.';
    } else if (url.startsWith('https://')) {
      googleScriptUrl = url;
      safeSetItem('google_script_url', googleScriptUrl);
      btnTestConnection.disabled = false;
      urlMessage = 'La URL fue almacenada correctamente.';
    } else {
      showToast('error', 'URL inválida', 'La URL debe comenzar con https://');
      return;
    }

    const apiKeyInput = document.getElementById('input-api-key');
    if (apiKeyInput && apiKeyInput.value.trim() !== '') {
      googleScriptApiKey = apiKeyInput.value.trim();
      safeSetItem('google_script_api_key', googleScriptApiKey);
    }

    // Guardar configuraciones de seguridad
    const chkMobile = document.getElementById('chk-block-mobile');
    const chkPcs = document.getElementById('chk-restrict-pcs');
    if (chkMobile) {
      securityBlockMobile = chkMobile.checked;
      safeSetItem('security_block_mobile', securityBlockMobile);
    }
    if (chkPcs) {
      securityRestrictPcs = chkPcs.checked;
      safeSetItem('security_restrict_pcs', securityRestrictPcs);
      if (securityRestrictPcs) {
        // Auto-autorizar esta PC actual para evitar bloqueo inmediato del administrador
        const expectedToken = ADMIN_PASSWORD_HASH;
        safeSetItem('asistencia_pc_auth_token', expectedToken);
      }
    }
    validateDeviceSecurity();

    // Sincronizar configuración global a Google Sheets si hay URL configurada
    if (googleScriptUrl) {
      fetch(getScriptUrlWithApiKey(), {
        method: 'POST',
        mode: 'no-cors',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'Guardar_Configuracion',
          apiKey: googleScriptApiKey,
          security_block_mobile: securityBlockMobile,
          security_restrict_pcs: securityRestrictPcs,
          tardiness_tolerance: tardinessTolerance,
          api_key: googleScriptApiKey
        })
      }).catch(err => console.error('Error sincronizando configuración global:', err));
    }

    showToast('success', 'Configuración guardada ✅', `${urlMessage} Tolerancia de tardanza establecida en ${tardinessTolerance} minutos.`);
    
    // Actualizar reportes visibles de inmediato
    const select = document.getElementById('select-report-employee');
    if (select && select.value) {
      renderAgentReport(select.value);
    }
    loadConsolidatedReport();
  });

  // Eventos para el Generador de Hash de Contraseña
  const inputHashPassword = document.getElementById('input-hash-password');
  const inputHashResult = document.getElementById('input-hash-result');
  const btnCopyHash = document.getElementById('btn-copy-hash');

  if (inputHashPassword && inputHashResult && btnCopyHash) {
    inputHashPassword.addEventListener('input', () => {
      const val = inputHashPassword.value.trim();
      if (val === '') {
        inputHashResult.value = '';
        btnCopyHash.disabled = true;
      } else {
        const hash = generateAuthToken(val);
        inputHashResult.value = hash;
        btnCopyHash.disabled = false;
      }
    });

    btnCopyHash.addEventListener('click', () => {
      const text = inputHashResult.value;
      if (navigator.clipboard) {
        navigator.clipboard.writeText(text).then(() => {
          showToast('success', 'Hash Copiado', 'Pégalo en ADMIN_PASSWORD_HASH en la línea 1 de app.js.');
        }).catch(err => {
          inputHashResult.select();
          document.execCommand('copy');
          showToast('success', 'Hash Copiado', 'Pégalo en ADMIN_PASSWORD_HASH en la línea 1 de app.js.');
        });
      } else {
        inputHashResult.select();
        document.execCommand('copy');
        showToast('success', 'Hash Copiado', 'Pégalo en ADMIN_PASSWORD_HASH en la línea 1 de app.js.');
      }
    });
  }

  // Dynamic change listener for tardiness tolerance input
  const toleranceInput = document.getElementById('input-tardiness-tolerance');
  if (toleranceInput) {
    toleranceInput.addEventListener('change', () => {
      const tolVal = parseInt(toleranceInput.value, 10);
      if (!isNaN(tolVal) && tolVal >= 0) {
        tardinessTolerance = tolVal;
        safeSetItem('tardiness_tolerance', tardinessTolerance);
        
        const select = document.getElementById('select-report-employee');
        if (select && select.value) {
          renderAgentReport(select.value);
        }
        loadConsolidatedReport();
      }
    });
  }

  // Button hooks for Exports and PDF
  const btnExportAgentExcel = document.getElementById('btn-export-agent-excel');
  if (btnExportAgentExcel) {
    btnExportAgentExcel.addEventListener('click', exportAgentReportExcel);
  }

  const btnExportAgentPdf = document.getElementById('btn-export-agent-pdf');
  if (btnExportAgentPdf) {
    btnExportAgentPdf.addEventListener('click', () => {
      const select = document.getElementById('select-report-employee');
      if (!select || !select.value) {
        showToast('warning', 'Selecciona colaborador', 'Primero debes elegir un colaborador para imprimir su reporte.');
        return;
      }
      updatePrintTimestamp();
      window.print();
    });
  }

  const btnExportConsolidatedPdf = document.getElementById('btn-export-consolidated-pdf');
  if (btnExportConsolidatedPdf) {
    btnExportConsolidatedPdf.addEventListener('click', () => {
      updatePrintTimestamp();
      window.print();
    });
  }

  const btnExportConsolidatedExcel = document.getElementById('btn-export-consolidated-excel');
  if (btnExportConsolidatedExcel) {
    btnExportConsolidatedExcel.addEventListener('click', exportConsolidatedExcel);
  }

  const btnExportMonthlyPdf = document.getElementById('btn-export-monthly-pdf');
  if (btnExportMonthlyPdf) {
    btnExportMonthlyPdf.addEventListener('click', () => {
      const monthInput = document.getElementById('monthly-select-month');
      if (!monthInput || !monthInput.value) {
        showToast('warning', 'Selecciona mes', 'Primero debes procesar un mes para imprimir su reporte.');
        return;
      }
      updatePrintTimestamp();
      window.print();
    });
  }

  // Refresh URL input every time admin view is shown
  btnAdminToggle.addEventListener('change', () => {
    const savedUrl = localStorage.getItem('google_script_url');
    if (savedUrl && inputSheetUrl) inputSheetUrl.value = savedUrl;
  });
  
  // Test connection button
  btnTestConnection.addEventListener('click', testGoogleScriptConnection);

  // Lógica para registrar nuevo colaborador (Admin) - AHORA EN EL LUGAR CORRECTO
  const formRegisterEmployee = document.getElementById('form-register-employee');
  if (formRegisterEmployee) {
    formRegisterEmployee.addEventListener('submit', (e) => {
      e.preventDefault();
      
      const dni = document.getElementById('reg-dni').value.trim();
      const name = document.getElementById('reg-name').value.trim().toUpperCase();
      const age = parseInt(document.getElementById('reg-age').value);
      const gender = document.getElementById('reg-gender').value;
      const role = document.getElementById('reg-role').value.trim();
      
      // Nuevos campos de horario
      const workStart = document.getElementById('reg-work-start').value;
      const workEnd = document.getElementById('reg-work-end').value;
      const breakStart = document.getElementById('reg-break-start').value;
      const breakEnd = document.getElementById('reg-break-end').value;

      // Validar si el DNI ya existe
      if (employeesDatabase[dni]) {
        showToast('error', 'DNI Duplicado', 'Este número de DNI ya está registrado en el sistema.');
        return;
      }

      // Leer distribución semanal del acordeón
      const weeklySchedule = {};
      document.querySelectorAll('#reg-weekly-schedule-fields .day-schedule-row').forEach(row => {
        const dayKey = row.getAttribute('data-day');
        const startInput = row.querySelector('.reg-day-start');
        const endInput = row.querySelector('.reg-day-end');
        const hoursInput = row.querySelector('.reg-day-hours');
        const restCheckbox = row.querySelector('.reg-day-rest');
        const nobreakCheckbox = row.querySelector('.reg-day-nobreak');

        const isRestDay = restCheckbox ? restCheckbox.checked : false;
        const nobreak = nobreakCheckbox ? nobreakCheckbox.checked : false;
        weeklySchedule[dayKey] = {
          workStart: startInput ? startInput.value : "09:00",
          workEnd: endInput ? endInput.value : "18:00",
          expectedHours: hoursInput ? parseFloat(hoursInput.value) || 0 : 8,
          isRestDay: isRestDay,
          nobreak: nobreak
        };
      });

      // 1. Guardar en la base de datos dinámica
      const regScheduleTypeVal = document.getElementById('reg-schedule-type').value;
      const isFlexible = regScheduleTypeVal === 'flexible';
      
      const finalWorkStart = isFlexible ? "—" : workStart;
      const finalWorkEnd = isFlexible ? "—" : workEnd;
      const finalBreakStart = isFlexible ? "—" : breakStart;
      const finalBreakEnd = isFlexible ? "—" : breakEnd;
      const finalWeeklySchedule = isFlexible ? "flexible" : weeklySchedule;

      employeesDatabase[dni] = {
        name: name,
        role: role,
        age: age,
        gender: gender,
        pin: "1234", // PIN por defecto para el primer ingreso
        workStart: finalWorkStart,
        workEnd: finalWorkEnd,
        breakStart: finalBreakStart,
        breakEnd: finalBreakEnd,
        weeklySchedule: finalWeeklySchedule
      };

      // 2. Inicializar su estado de asistencia básico
      attendanceState[dni] = {
        action: 'Desconectado',
        timestamp: null,
        history: []
      };

      // 3. Persistir datos y actualizar vista del Admin
      saveState();
      updateAdminView();
      if (googleScriptUrl) {
         sendRegistrationToGoogleSheets(dni, name, age, gender, role, finalWorkStart, finalWorkEnd, finalBreakStart, finalBreakEnd, "1234", finalWeeklySchedule);
      }
      
      // Limpiar formulario y lanzar éxito
      formRegisterEmployee.reset();
      
      // Reestablecer Tipo de Jornada a Fijo
      const regScheduleType = document.getElementById('reg-schedule-type');
      const regScheduleContainer = document.getElementById('reg-schedule-details-container');
      if (regScheduleType && regScheduleContainer) {
        regScheduleType.value = 'fixed';
        regScheduleContainer.classList.remove('hidden');
        document.getElementById('reg-work-start').setAttribute('required', 'required');
        document.getElementById('reg-work-end').setAttribute('required', 'required');
        document.getElementById('reg-break-start').setAttribute('required', 'required');
        document.getElementById('reg-break-end').setAttribute('required', 'required');
      }

      // Reestablecer valores por defecto de tiempo
      document.getElementById('reg-work-start').value = "08:00";
      document.getElementById('reg-work-end').value = "17:00";
      document.getElementById('reg-break-start').value = "13:00";
      document.getElementById('reg-break-end').value = "14:00";
      
      // Reestablecer acordeón semanal
      document.querySelectorAll('#reg-weekly-schedule-fields .day-schedule-row').forEach(row => {
        const dayKey = row.getAttribute('data-day');
        const startInput = row.querySelector('.reg-day-start');
        const endInput = row.querySelector('.reg-day-end');
        const hoursInput = row.querySelector('.reg-day-hours');
        const restCheckbox = row.querySelector('.reg-day-rest');
        const nobreakCheckbox = row.querySelector('.reg-day-nobreak');
        
        if (nobreakCheckbox) {
          nobreakCheckbox.checked = false;
          nobreakCheckbox.disabled = (dayKey === '0');
        }

        if (dayKey === '0') {
          if (restCheckbox) restCheckbox.checked = true;
          if (hoursInput) hoursInput.value = '0';
        } else if (dayKey === '6') {
          if (restCheckbox) restCheckbox.checked = false;
          if (startInput) startInput.value = '09:00';
          if (endInput) endInput.value = '13:00';
          if (hoursInput) hoursInput.value = '4';
        } else {
          if (restCheckbox) restCheckbox.checked = false;
          if (startInput) startInput.value = '09:00';
          if (endInput) endInput.value = '18:00';
          if (hoursInput) hoursInput.value = '8';
        }
        
        if (restCheckbox) restCheckbox.dispatchEvent(new Event('change'));
      });
      
      showToast('success', 'Registro Exitoso ✅', `${name} ha sido agregado con éxito.`);
    });
  }

  // Gestión de Justificaciones Submit
  const formRegisterJustification = document.getElementById('form-register-justification');
  const justType = document.getElementById('just-type');
  const justHoursContainer = document.getElementById('just-hours-container');
  const justStartTime = document.getElementById('just-start-time');
  const justEndTime = document.getElementById('just-end-time');
  const justCompensation = document.getElementById('just-compensation');

  if (justType && justHoursContainer) {
    justType.addEventListener('change', () => {
      if (justType.value === 'Permiso por Horas') {
        justHoursContainer.style.display = 'grid';
        justHoursContainer.classList.remove('hidden');
        if (justStartTime) justStartTime.required = true;
        if (justEndTime) justEndTime.required = true;
      } else {
        justHoursContainer.style.display = 'none';
        justHoursContainer.classList.add('hidden');
        if (justStartTime) { justStartTime.required = false; justStartTime.value = ''; }
        if (justEndTime) { justEndTime.required = false; justEndTime.value = ''; }
      }
    });
  }

  if (formRegisterJustification) {
    formRegisterJustification.addEventListener('submit', (e) => {
      e.preventDefault();
      const dni = document.getElementById('just-employee').value;
      const dateVal = document.getElementById('just-date').value; // YYYY-MM-DD
      const type = justType ? justType.value : '';
      const details = document.getElementById('just-details').value.trim();
      
      let startTime = '';
      let endTime = '';
      let compensation = '';

      if (type === 'Permiso por Horas') {
        startTime = justStartTime ? justStartTime.value : '';
        endTime = justEndTime ? justEndTime.value : '';
        compensation = justCompensation ? justCompensation.value : 'Con goce';

        if (!startTime || !endTime) {
          showToast('warning', 'Campos incompletos', 'Por favor complete las horas del permiso.');
          return;
        }

        if (timeStrToSeconds(startTime) >= timeStrToSeconds(endTime)) {
          showToast('error', 'Horario inválido', 'La hora de inicio debe ser menor que la hora de fin.');
          return;
        }
      }

      if (!dni || !dateVal || !type || !details) {
        showToast('warning', 'Campos incompletos', 'Por favor rellene todos los campos.');
        return;
      }
      
      // Convertir fecha de YYYY-MM-DD a DD/MM/YYYY
      const parts = dateVal.split('-');
      const dateStr = `${parts[2]}/${parts[1]}/${parts[0]}`;
      
      registerJustificacion(dni, dateStr, type, details, startTime, endTime, compensation);
      
      // Limpiar campos del formulario
      document.getElementById('just-date').value = '';
      if (justType) justType.value = '';
      document.getElementById('just-details').value = '';
      document.getElementById('just-employee').value = '';
      if (justStartTime) { justStartTime.value = ''; justStartTime.required = false; }
      if (justEndTime) { justEndTime.value = ''; justEndTime.required = false; }
      if (justHoursContainer) {
        justHoursContainer.style.display = 'none';
        justHoursContainer.classList.add('hidden');
      }
    });
  }

  // Gestión de Feriados Submit
  const formRegisterHoliday = document.getElementById('form-register-holiday');
  if (formRegisterHoliday) {
    formRegisterHoliday.addEventListener('submit', (e) => {
      e.preventDefault();
      const dateVal = document.getElementById('holiday-date').value; // YYYY-MM-DD
      const name = document.getElementById('holiday-name').value.trim();
      
      if (!dateVal || !name) {
        showToast('warning', 'Campos incompletos', 'Por favor rellene todos los campos.');
        return;
      }
      
      // Convertir fecha de YYYY-MM-DD a DD/MM/YYYY
      const parts = dateVal.split('-');
      const dateStr = `${parts[2]}/${parts[1]}/${parts[0]}`;
      
      registerFeriado(dateStr, name);
      
      // Limpiar campos
      document.getElementById('holiday-date').value = '';
      document.getElementById('holiday-name').value = '';
    });
  }

  // Filtro de año de feriados
  const filterHolidayYear = document.getElementById('filter-holiday-year');
  if (filterHolidayYear) {
    filterHolidayYear.addEventListener('change', () => {
      renderFeriadosTable();
    });
  }
}

// Post attendance payload to Google Apps Script Web App
function sendAttendanceToGoogleSheets(dni, name, action, customTimeObj = null, silent = false) {
  if (!silent) {
    showToast('warning', 'Sincronizando...', 'Registrando marca de asistencia...');
  }
  
  const payload = {
    action: action,
    apiKey: googleScriptApiKey,
    employeeId: dni,
    employeeName: name,
    details: "Registrado vía AsistenciaPro Web",
    device: obtenerDispositivo()
  };

  if (customTimeObj) {
    payload.customDate = customTimeObj.toLocaleDateString('es-ES', { day: 'numeric', month: 'numeric', year: 'numeric' });
    payload.customTime = customTimeObj.toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    payload.customTimestamp = customTimeObj.getTime();
    payload.details = "Autocompletado por omisión";
    payload.device = "Sistema";
  }
  
  fetch(getScriptUrlWithApiKey(), {
    method: 'POST',
    mode: 'no-cors',
    headers: {
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(payload)
  })
  .then(() => {
    if (!silent) {
      showToast('success', 'Sincronización Exitosa', `Se registró '${action}' correctamente.`);
    }
  })
  .catch(err => {
    console.error('Error post sheet:', err);
    if (!silent) {
      showToast('error', 'Error de Conexión', 'Se guardó localmente de manera segura.');
    }
  });
}

/* ==========================================================================
   ADMIN PANEL UPDATE & METRICS
   ========================================================================== */

/* ==========================================================================
   ADMIN PANEL UPDATE & METRICS
   ========================================================================== */

function updateAdminView() {
  const allStaffIds = Object.keys(employeesDatabase);
  // Filtrar solo a los activos para mostrar en el sistema a partir de su fecha de baja
  const staffIds = allStaffIds.filter(dni => isEmployeeActive(employeesDatabase[dni]));
  statTotalStaff.textContent = staffIds.length;
  
  let activeToday = 0;
  let inBreak = 0;
  
  const todayDateObj = new Date();
  const normToday = getTodayNormalizedDateStr(todayDateObj);
  const todayStr = normToday;
  const dayOfWeek = todayDateObj.getDay(); // 0 = Domingo, 1 = Lunes, etc.
  
  let presentCount = 0;
  let tardyCount = 0;
  let justifiedCount = 0;
  let restCount = 0;
  let absentCount = 0;
  
  adminLiveTableBody.innerHTML = '';
  
  staffIds.forEach(dni => {
    const employee = employeesDatabase[dni]; 
    const state = attendanceState[dni] || { action: 'Desconectado', timestamp: null, history: [] };
    
    // Calculate stats for header cards
    if (state.action === 'Ingreso' || state.action === 'Fin Refrigerio') {
      activeToday++;
    } else if (state.action === 'Inicio Refrigerio') {
      inBreak++;
      activeToday++;
    }
    
    // Calculate analytics metrics
    const justification = justificacionesDatabase.find(j => 
      String(j.dni) === String(dni) && 
      normalizeDateStr(j.dateStr) === normToday
    );
    
    const FERIADOS = [
      "01/01", "01/05", "29/06", "23/07", "28/07", "29/07", 
      "06/08", "30/08", "08/10", "01/11", "08/12", "09/12", "25/12"
    ];
    const dStr = String(todayDateObj.getDate()).padStart(2, '0');
    const mStr = String(todayDateObj.getMonth() + 1).padStart(2, '0');
    const dayMonth = `${dStr}/${mStr}`;
    const isStaticHoliday = GLOBAL_FERIADOS.includes(dayMonth);
    const customHoliday = feriadosDatabase.find(f => normalizeDateStr(f.dateStr) === normToday);
    const isHoliday = isStaticHoliday || !!customHoliday;
    
    let daySched = null;
    let schedObj = employee.weeklySchedule;
    if (typeof schedObj === 'string' && schedObj.trim() !== '') {
      try { schedObj = JSON.parse(schedObj); } catch(e) { schedObj = null; }
    }
    if (schedObj && schedObj[dayOfWeek]) {
      daySched = schedObj[dayOfWeek];
    }
    if (!daySched) {
      if (dayOfWeek === 0) daySched = { isRestDay: true };
      else if (dayOfWeek === 6) daySched = { isRestDay: false };
      else daySched = { isRestDay: false };
    }
    const isRestDay = !!daySched.isRestDay;
    
    const todayMarks = (state.history || []).filter(item => normalizeDateStr(item.dateStr) === normToday);
    const hasIngreso = todayMarks.some(m => m.action === 'Ingreso');
    
    if (hasIngreso) {
      presentCount++;
      const report = calculateWorkedTimesForDate(todayMarks, employee, todayStr);
      if (report.tardiness) {
        tardyCount++;
      }
    } else {
      if (justification) {
        justifiedCount++;
      } else if (isRestDay || isHoliday) {
        restCount++;
      } else {
        absentCount++;
      }
    }
    
    // Encontrar la marca más reciente en todo el historial
    let lastMarkTime = '---';
    let deviceDisplay = '---';
    if (state.history && state.history.length > 0) {
      const sortedHistory = [...state.history].sort((a, b) => a.timestamp - b.timestamp);
      const lastMark = sortedHistory[sortedHistory.length - 1];
      if (lastMark) {
        lastMarkTime = `${lastMark.dateStr} ${lastMark.timeStr.substring(0, 5)}`;
        deviceDisplay = lastMark.device || '---';
      }
    }
    
    // Status Badge classes
    let statusClass = 'Desconectado';
    if (state.action === 'Inicio Refrigerio') statusClass = 'Inicio-Refrigerio';
    else if (state.action === 'Fin Refrigerio') statusClass = 'Fin-Refrigerio';
    else if (state.action === 'Ingreso') statusClass = 'Ingreso';
    else if (state.action === 'Salida') statusClass = 'Salida';
    
    // Table Row creation
    const cleanDni = String(dni).replace(/'/g, '').trim();
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td class="table-employee-name">${escapeHtml(employee.name)}</td>
      <td>${escapeHtml(cleanDni)}</td>
      <td>
        <span class="table-status-badge ${statusClass}">
          <span class="status-dot ${state.action === 'Desconectado' ? '' : 'status-' + (state.action === 'Inicio Refrigerio' ? 'break' : (state.action === 'Salida' ? 'inactive' : 'active'))}"></span>
          ${state.action === 'Inicio Refrigerio' ? 'En Refrigerio' : (state.action === 'Fin Refrigerio' ? 'Trabajando' : (state.action === 'Ingreso' ? 'Trabajando' : state.action))}
        </span>
      </td>
      <td class="table-timestamp">${lastMarkTime}</td>
      <td>${getDeviceIconHTML(deviceDisplay)}</td>
      <td>
        <div style="display: flex; gap: 8px; align-items: center; white-space: nowrap;">
          <button type="button" class="btn-table-action btn-admin-logout" data-dni="${escapeHtml(cleanDni)}" onclick="event.preventDefault(); forceLogoutEmployee('${escapeHtml(cleanDni)}');" title="Forzar Salida" style="display: inline-flex; align-items: center; gap: 4px; white-space: nowrap; cursor: pointer;">
            <span class="material-symbols-rounded" style="font-size: 16px; pointer-events: none;">logout</span>
            <span style="pointer-events: none;">Forzar Salida</span>
          </button>
          <button type="button" class="btn-table-action btn-admin-edit" data-dni="${escapeHtml(cleanDni)}" onclick="event.preventDefault(); openEditEmployeeModal('${escapeHtml(cleanDni)}');" title="Editar" style="display: inline-flex; align-items: center; gap: 4px; white-space: nowrap; cursor: pointer;">
            <span class="material-symbols-rounded" style="font-size: 16px; pointer-events: none;">edit</span>
            <span style="pointer-events: none;">Editar</span>
          </button>
          <button type="button" class="btn-table-action btn-admin-delete" data-dni="${escapeHtml(cleanDni)}" onclick="event.preventDefault(); deleteEmployee('${escapeHtml(cleanDni)}');" title="Eliminar" style="display: inline-flex; align-items: center; gap: 4px; color: #ff4d4d; border-color: #ff4d4d; white-space: nowrap; cursor: pointer;">
            <span class="material-symbols-rounded" style="font-size: 16px; pointer-events: none;">delete</span>
            <span style="pointer-events: none;">Eliminar</span>
          </button>
        </div>
      </td>
    `;
    adminLiveTableBody.appendChild(tr);
  });
  
  // Attach event delegation on adminLiveTableBody
  if (adminLiveTableBody) {
    adminLiveTableBody.onclick = function(e) {
      const btn = e.target.closest('.btn-table-action');
      if (!btn) return;
      e.preventDefault();
      const dni = btn.getAttribute('data-dni');
      if (!dni) return;

      if (btn.classList.contains('btn-admin-logout')) {
        forceLogoutEmployee(dni);
      } else if (btn.classList.contains('btn-admin-edit')) {
        openEditEmployeeModal(dni);
      } else if (btn.classList.contains('btn-admin-delete')) {
        deleteEmployee(dni);
      }
    };
  }
  
  statActiveToday.textContent = activeToday;
  statInBreak.textContent = inBreak;
  
  // Calcular y pintar métricas analíticas
  const totalActive = staffIds.length;
  const expectedToWork = totalActive - justifiedCount - restCount;
  const attendancePct = expectedToWork > 0 ? Math.round((presentCount / expectedToWork) * 100) : 0;
  const punctualityPct = presentCount > 0 ? Math.round(((presentCount - tardyCount) / presentCount) * 100) : 0;
  
  const elAttRing = document.getElementById('analytics-attendance-ring');
  const elAttPct = document.getElementById('analytics-attendance-pct');
  const elAttText = document.getElementById('analytics-attendance-text');
  
  const elPuncRing = document.getElementById('analytics-punctuality-ring');
  const elPuncPct = document.getElementById('analytics-punctuality-pct');
  const elPuncText = document.getElementById('analytics-punctuality-text');
  
  const elAbsentCount = document.getElementById('analytics-absent-count');
  const elJustifiedCount = document.getElementById('analytics-justified-count');
  const elRestCount = document.getElementById('analytics-rest-count');
  
  if (elAttRing) {
    elAttRing.style.strokeDasharray = `${attendancePct}, 100`;
  }
  if (elAttPct) elAttPct.textContent = `${attendancePct}%`;
  if (elAttText) elAttText.textContent = `${presentCount} de ${Math.max(0, expectedToWork)} esperados`;
  
  if (elPuncRing) {
    elPuncRing.style.strokeDasharray = `${punctualityPct}, 100`;
  }
  if (elPuncPct) elPuncPct.textContent = `${punctualityPct}%`;
  if (elPuncText) elPuncText.textContent = `${presentCount - tardyCount} de ${presentCount} a tiempo`;
  
  if (elAbsentCount) elAbsentCount.textContent = absentCount;
  if (elJustifiedCount) elJustifiedCount.textContent = justifiedCount;
  if (elRestCount) elRestCount.textContent = restCount;
  
  // Actualizar la lista del selector de reportes
  updateReportEmployeeSelect();
}

function forceLogoutEmployee(dni) {
  logDebug(`[EJECUTANDO] Forzar Salida para DNI: ${dni}`);
  const emp = findEmployeeByDni(dni);
  if (!emp) {
    logDebug(`[ERROR] No se encontró colaborador con DNI: ${dni}`, 'error');
    showToast('error', 'Error', 'No se encontró el registro del colaborador.');
    return;
  }
  const empName = emp.name;
  const targetDni = String(emp.dni).replace(/'/g, '').trim();
  logDebug(`[MODAL] Abriendo confirmación Forzar Salida para ${empName}`);

  showCustomConfirm({
    title: 'Forzar Salida',
    message: `¿Estás seguro de que deseas forzar la salida de <strong>${empName}</strong>?<br><span style="font-size: 0.85rem; color: var(--text-muted);">Esta acción registrará la salida del colaborador de forma inmediata.</span>`,
    type: 'warning',
    acceptText: 'Forzar Salida'
  }).then((confirmed) => {
    if (confirmed) {
      const now = new Date();
      const timeStr = now.toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
      const dateStr = now.toLocaleDateString('es-ES', { day: 'numeric', month: 'numeric', year: 'numeric' });
      
      const logItem = {
        action: 'Salida',
        timestamp: now.getTime(),
        timeStr: timeStr,
        dateStr: dateStr,
        details: "Forzado por Administrador"
      };
      
      if (!attendanceState[targetDni]) {
        attendanceState[targetDni] = { action: 'Desconectado', timestamp: null, history: [] };
      }
      attendanceState[targetDni].action = 'Salida';
      attendanceState[targetDni].timestamp = now.getTime();
      if (!Array.isArray(attendanceState[targetDni].history)) {
        attendanceState[targetDni].history = [];
      }
      attendanceState[targetDni].history.push(logItem);
      saveState();
      
      if (googleScriptUrl) {
        sendAttendanceToGoogleSheets(targetDni, empName, 'Salida');
      }
      
      showToast('warning', 'Salida Forzada', `Se forzó la salida de ${empName}`);
      updateAdminView();
      
      if (currentSession && String(currentSession.dni).replace(/'/g, '').trim() === targetDni) {
        currentSession = null;
        showView('login');
      }
    }
  });
}
window.forceLogoutEmployee = forceLogoutEmployee;

/* ==========================================================================
   TEST CONNECTION LÓGICA
   ========================================================================== */

function testGoogleScriptConnection() {
  if (!googleScriptUrl) return;
  
  testConnectionResult.textContent = "Probando conexión...";
  testConnectionResult.className = "test-result-msg";
  
  const payload = {
    action: "login",
    apiKey: googleScriptApiKey,
    employeeId: "73507283",
    pin: "1234"
  };
  
  // We make a simple POST login fetch to test connection
  fetch(getScriptUrlWithApiKey(), {
    method: 'POST',
    mode: 'no-cors', // with no-cors we can send, but cannot read the body response. It will fulfill the promise successfully if the server receives and completes.
    headers: {
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(payload)
  })
  .then(() => {
    testConnectionResult.textContent = "¡Conexión establecida con éxito! El script responde.";
    testConnectionResult.classList.add('success');
    showToast('success', 'Conexión exitosa', 'El script de Google Sheets está activo.');
    syncEmployeesFromGoogleSheets();
  })
  .catch(err => {
    console.error(err);
    testConnectionResult.textContent = "Error al conectar. Verifica los permisos o el link.";
    testConnectionResult.classList.add('error');
    showToast('error', 'Error de conexión', 'No se pudo establecer contacto con el script.');
  });
}

/* ==========================================================================
   NAVIGATION VIEW CONTROLLER
   ========================================================================== */

function showView(viewId) {
  Object.keys(views).forEach(key => {
    if (key === viewId) {
      views[key].classList.remove('hidden');
    } else {
      views[key].classList.add('hidden');
    }
  });
}

/* ==========================================================================
   ADMIN TABS SWITCHER ENGINE
   ========================================================================== */

function switchAdminTab(targetTab) {
  if (!targetTab) return;

  const tabButtons = document.querySelectorAll('.btn-admin-tab');
  const tabContents = document.querySelectorAll('.admin-tab-content');

  tabButtons.forEach(b => {
    if (b.getAttribute('data-tab') === targetTab) {
      b.classList.add('active');
    } else {
      b.classList.remove('active');
    }
  });

  // ── Sincronizar bottom nav mobile ──
  document.querySelectorAll('.admin-mob-tab').forEach(b => {
    if (b.getAttribute('data-tab') === targetTab) {
      b.classList.add('active');
    } else {
      b.classList.remove('active');
    }
  });

  tabContents.forEach(c => {
    c.classList.remove('active');
    c.classList.add('hidden');
  });

  const activeContent = document.getElementById(`tab-${targetTab}-content`);
  if (activeContent) {
    activeContent.classList.remove('hidden');
    activeContent.classList.add('active');
  }

  const pageTitleEl = document.querySelector('.admin-page-title');
  if (pageTitleEl) {
    const titleMap = {
      'live': 'Panel de Monitoreo General',
      'daily': 'Resumen Diario de Asistencia',
      'consolidated': 'Resumen General Consolidado',
      'monthly': 'Resumen y Récord Mensual',
      'reports': 'Reportes Detallados por Agente',
      'gerencial': 'Vista y Métricas Gerenciales',
      'validations': 'Control de Validaciones y Sanciones',
      'register': 'Gestión de Personal y Configuración'
    };
    pageTitleEl.textContent = titleMap[targetTab] || 'Panel de Administración';
  }

  if (targetTab === 'live') {
    if (typeof updateAdminView === 'function') updateAdminView();
  } else if (targetTab === 'daily') {
    if (typeof renderDailySummaryTable === 'function') renderDailySummaryTable();
  } else if (targetTab === 'consolidated') {
    if (typeof loadConsolidatedReport === 'function') loadConsolidatedReport();
  } else if (targetTab === 'monthly') {
    if (typeof loadMonthlyReport === 'function') loadMonthlyReport();
  } else if (targetTab === 'reports') {

    const select = document.getElementById('select-report-employee');
    if (select && select.value && typeof renderAgentReport === 'function') renderAgentReport(select.value);
  } else if (targetTab === 'gerencial') {
    if (typeof renderGerencialView === 'function') renderGerencialView();
  } else if (targetTab === 'validations') {
    if (typeof renderValidationsView === 'function') renderValidationsView();
  } else if (targetTab === 'register') {
    if (typeof renderEmployeeTable === 'function') renderEmployeeTable();
    if (typeof renderFeriadosTable === 'function') renderFeriadosTable();
    if (typeof renderJustificacionesTable === 'function') renderJustificacionesTable();
  }
}
window.switchAdminTab = switchAdminTab;



/* ==========================================================================
   TOAST NOTIFICATION ENGINE
   ========================================================================== */

function showToast(type, title, message) {
  const toast = document.createElement('div');
  toast.className = `toast ${type}`;
  
  let iconName = 'info';
  if (type === 'success') iconName = 'check_circle';
  else if (type === 'error') iconName = 'error';
  else if (type === 'warning') iconName = 'warning';
  
  toast.innerHTML = `
    <span class="material-symbols-rounded toast-icon">${iconName}</span>
    <div class="toast-body">
      <h5>${title}</h5>
      <p>${message}</p>
    </div>
  `;
  
  toastContainer.appendChild(toast);

  // Remove toast after 4 seconds
  setTimeout(() => {
    toast.style.animation = 'slide-in 0.35s cubic-bezier(0.4, 0, 0.2, 1) reverse';
    setTimeout(() => {
      toast.remove();
    }, 350);
  }, 4000);
}

function showCustomConfirm(options) {
  return new Promise((resolve) => {
    const modal = document.getElementById('modal-confirm');
    const titleEl = document.getElementById('confirm-modal-title');
    const msgEl = document.getElementById('confirm-modal-message');
    const iconEl = document.getElementById('confirm-modal-icon');
    const iconContainer = document.getElementById('confirm-modal-icon-container');
    const btnAccept = document.getElementById('btn-confirm-accept');
    const btnCancel = document.getElementById('btn-confirm-cancel');
    
    if (!modal || !btnAccept || !btnCancel) {
      resolve(confirm(options.message ? options.message.replace(/<[^>]*>/g, '') : '¿Confirmar?'));
      return;
    }
    
    titleEl.textContent = options.title || '¿Estás seguro?';
    msgEl.innerHTML = options.message || '';
    
    if (options.type === 'danger') {
      iconContainer.style.background = 'rgba(239, 68, 68, 0.1)';
      iconContainer.style.border = '2px solid #ef4444';
      iconEl.style.color = '#ef4444';
      iconEl.textContent = 'delete_forever';
      btnAccept.style.background = '#ef4444';
      btnAccept.style.borderColor = '#ef4444';
      btnAccept.style.color = '#ffffff';
      btnAccept.textContent = options.acceptText || 'Eliminar';
    } else {
      iconContainer.style.background = 'rgba(245, 158, 11, 0.1)';
      iconContainer.style.border = '2px solid #f59e0b';
      iconEl.style.color = '#f59e0b';
      iconEl.textContent = 'warning';
      btnAccept.style.background = '#f59e0b';
      btnAccept.style.borderColor = '#f59e0b';
      btnAccept.style.color = '#ffffff';
      btnAccept.textContent = options.acceptText || 'Aceptar';
    }
    
    // Replace nodes to strip previous click listeners
    const newBtnAccept = btnAccept.cloneNode(true);
    const newBtnCancel = btnCancel.cloneNode(true);
    btnAccept.parentNode.replaceChild(newBtnAccept, btnAccept);
    btnCancel.parentNode.replaceChild(newBtnCancel, btnCancel);

    modal.classList.remove('hidden');
    modal.style.display = 'flex';
    modal.style.zIndex = '10000';
    
    const closeModal = () => {
      modal.classList.add('hidden');
      modal.style.display = 'none';
    };
    
    newBtnAccept.addEventListener('click', () => {
      closeModal();
      resolve(true);
    }, { once: true });
    
    newBtnCancel.addEventListener('click', () => {
      closeModal();
      resolve(false);
    }, { once: true });
  });
}

/* ==========================================================================
   DEVICE DETECTION UTILITIES
   ========================================================================== */

function obtenerDispositivo() {
  const ua = navigator.userAgent;
  if (/mobile/i.test(ua)) {
    if (/ipad|tablet/i.test(ua)) {
      return "Tablet";
    }
    return /iphone|ipad|ipod/i.test(ua) ? "Celular (iOS)" : "Celular (Android)";
  }
  if (/windows/i.test(ua)) return "PC (Windows)";
  if (/macintosh/i.test(ua)) return "PC (macOS)";
  if (/linux/i.test(ua)) return "PC (Linux)";
  return "PC / Escritorio";
}

function getDeviceIconHTML(deviceStr) {
  if (!deviceStr || deviceStr === '---') return '<span style="color: var(--text-muted)">---</span>';
  
  let iconName = "help";
  let color = "var(--text-secondary)";
  let title = deviceStr;
  
  const devLower = deviceStr.toLowerCase();
  if (devLower.includes("celular") || devLower.includes("mobile") || devLower.includes("phone")) {
    iconName = "smartphone";
  } else if (devLower.includes("tablet") || devLower.includes("ipad")) {
    iconName = "tablet_mac";
  } else if (devLower.includes("pc") || devLower.includes("windows") || devLower.includes("macos") || devLower.includes("escritorio") || devLower.includes("desktop")) {
    iconName = "desktop_windows";
  } else if (devLower.includes("sistema") || devLower.includes("auto")) {
    iconName = "settings";
    color = "var(--text-muted)";
  }
  
  return `<div style="display: inline-flex; align-items: center; gap: 6px;"><span class="material-symbols-rounded" style="font-size: 18px; color: ${color};" title="${title}">${iconName}</span> <span style="font-size: 0.85rem;">${deviceStr}</span></div>`;
}

function getDeviceIconShortHTML(deviceStr) {
  if (!deviceStr || deviceStr === '---') return '';
  let iconName = "help";
  let color = "var(--text-secondary)";
  
  const devLower = deviceStr.toLowerCase();
  if (devLower.includes("celular") || devLower.includes("mobile") || devLower.includes("phone")) {
    iconName = "smartphone";
  } else if (devLower.includes("tablet") || devLower.includes("ipad")) {
    iconName = "tablet_mac";
  } else if (devLower.includes("pc") || devLower.includes("windows") || devLower.includes("macos") || devLower.includes("escritorio") || devLower.includes("desktop")) {
    iconName = "desktop_windows";
  } else if (devLower.includes("sistema") || devLower.includes("auto")) {
    iconName = "settings";
    color = "var(--text-muted)";
  }
  
  return `<span class="material-symbols-rounded" style="vertical-align: middle; font-size: 15px; color: ${color}; margin-left: 4px;" title="${deviceStr}">${iconName}</span>`;
}

function updatePrintTimestamp() {
  const spans = document.querySelectorAll('.print-timestamp-span');
  const now = new Date();
  const dateStr = now.toLocaleDateString('es-ES', { day: '2-digit', month: '2-digit', year: 'numeric' }) + ' ' + now.toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit' });
  spans.forEach(s => s.textContent = dateStr);
}

function autoClosePendingSessions() {
  let stateChanged = false;
  const today = new Date();
  const todayStr = today.toLocaleDateString('es-ES', { day: 'numeric', month: 'numeric', year: 'numeric' });
  const normToday = normalizeDateStr(todayStr);

  // Registro persistente de sesiones ya cerradas: { dni: 'DD/MM/YYYY' }
  // Evita re-procesar la misma sesión en cada recarga de página
  let alreadyClosed = {};
  try {
    alreadyClosed = JSON.parse(localStorage.getItem('autoclose_processed') || '{}');
  } catch(e) { alreadyClosed = {}; }

  Object.keys(attendanceState).forEach(dni => {
    const state = attendanceState[dni];
    if (!state || !state.history || state.history.length === 0) return;

    // Ordenar historial para encontrar la marca más reciente
    state.history.sort((a, b) => a.timestamp - b.timestamp);
    const lastLog = state.history[state.history.length - 1];
    const lastDateNorm = normalizeDateStr(lastLog.dateStr);

    // No procesar si:
    // 1) La última acción ya es Salida
    // 2) La última marca es de hoy
    // 3) Esta sesión (dni + fecha) ya fue autocerrada antes
    const alreadyKey = `${dni}_${lastDateNorm}`;
    if (lastLog.action === 'Salida') return;
    if (lastDateNorm === normToday) return;
    if (alreadyClosed[alreadyKey]) return;

    const dateParts = lastLog.dateStr.split('/');
    if (dateParts.length !== 3) return;

    const day   = parseInt(dateParts[0], 10);
    const month = parseInt(dateParts[1], 10) - 1;
    const year  = parseInt(dateParts[2], 10);

    // Caso 1: Si se quedó en 'Inicio Refrigerio', cerrar refrigerio antes
    if (lastLog.action === 'Inicio Refrigerio') {
      const breakTime = new Date(year, month, day, 23, 59, 58);
      const breakLog = {
        action: 'Fin Refrigerio',
        timestamp: breakTime.getTime(),
        timeStr: '23:59:58',
        dateStr: lastLog.dateStr,
        details: 'Autocompletado por omisión',
        device: 'Sistema'
      };
      state.history.push(breakLog);
      if (googleScriptUrl) {
        sendAttendanceToGoogleSheets(dni, employeesDatabase[dni]?.name || '', 'Fin Refrigerio', breakTime, true);
      }
    }

    // Cerrar jornada a las 23:59:59 del día de la última marca
    const exitTime = new Date(year, month, day, 23, 59, 59);
    const exitLog = {
      action: 'Salida',
      timestamp: exitTime.getTime(),
      timeStr: '23:59:59',
      dateStr: lastLog.dateStr,
      details: 'Autocompletado por omisión',
      device: 'Sistema'
    };
    state.history.push(exitLog);
    state.action = 'Salida';
    state.timestamp = exitTime.getTime();

    if (googleScriptUrl) {
      sendAttendanceToGoogleSheets(dni, employeesDatabase[dni]?.name || '', 'Salida', exitTime, true);
    }

    // Marcar como procesado para no repetir en futuras recargas
    alreadyClosed[alreadyKey] = true;
    stateChanged = true;
  });

  // Guardar el registro de sesiones ya cerradas
  try {
    localStorage.setItem('autoclose_processed', JSON.stringify(alreadyClosed));
  } catch(e) {}

  if (stateChanged) {
    saveState();
  }
}

// Lógica para ELIMINAR a un empleado del sistema (Movida fuera de showToast)
function deleteEmployee(dni) {
  logDebug(`[EJECUTANDO] Eliminar Colaborador DNI: ${dni}`);
  const emp = findEmployeeByDni(dni);
  const targetDni = emp ? String(emp.dni).replace(/'/g, '').trim() : String(dni).replace(/'/g, '').trim();
  const empName = emp ? emp.name : `Colaborador (${targetDni})`;
  logDebug(`[MODAL] Abriendo confirmación Eliminar para ${empName}`);
  
  showCustomConfirm({
    title: 'Eliminar Colaborador',
    message: `⚠️ ¿Estás seguro de que deseas ELIMINAR a <strong>${empName}</strong> del sistema?<br><span style="font-size: 0.85rem; color: var(--text-muted);">Esta acción no se puede deshacer y el colaborador ya no podrá registrar asistencia.</span>`,
    type: 'danger',
    acceptText: 'Eliminar'
  }).then((confirmed) => {
    if (confirmed) {
      // 1. Borrar todas las variaciones de la clave de la base de datos local
      Object.keys(employeesDatabase).forEach(k => {
        if (String(k).replace(/'/g, '').trim() === targetDni) {
          delete employeesDatabase[k];
        }
      });
      Object.keys(attendanceState).forEach(k => {
        if (String(k).replace(/'/g, '').trim() === targetDni) {
          delete attendanceState[k];
        }
      });
      saveState();
      
      // 2. Actualizar las vistas del administrador
      updateAdminView();
      if (typeof updateReportEmployeeSelect === 'function') {
        updateReportEmployeeSelect();
      }
      showToast('success', 'Personal Eliminado', `${empName} fue retirado del sistema.`);
      
      // 3. Enviar orden a Google Sheets para borrarlo de la pestaña "Personal"
      if (googleScriptUrl) {
        const payload = {
          action: "Eliminar_Personal",
          apiKey: googleScriptApiKey,
          employeeId: targetDni
        };
        
        fetch(getScriptUrlWithApiKey(), {
          method: 'POST',
          mode: 'no-cors',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload)
        }).then(() => {
          setTimeout(() => {
            if (typeof syncEmployeesFromGoogleSheets === 'function') {
              syncEmployeesFromGoogleSheets();
            }
          }, 1500);
        }).catch(err => {
          console.error("Error al eliminar colaborador:", err);
        });
      }
    }
  });
}
window.deleteEmployee = deleteEmployee;

/* ==========================================================================
   REPORTES POR AGENTE - LÓGICA DE TIEMPOS Y REPORTES
   ========================================================================== */

// Funciones de normalización de fecha y hora para datos de Google Sheets
function parseDayMonthYear(s) {
  const parts = s.split('/');
  if (parts.length === 3) {
    const day = parseInt(parts[0], 10);
    const month = parseInt(parts[1], 10);
    const year = parseInt(parts[2], 10);
    if (!isNaN(day) && !isNaN(month) && !isNaN(year)) {
      return { day, month, year };
    }
  }
  return null;
}

function getTodayNormalizedDateStr(dateObj = new Date()) {
  const d = (dateObj instanceof Date && !isNaN(dateObj.getTime())) ? dateObj : new Date();
  const day = String(d.getDate()).padStart(2, '0');
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const year = d.getFullYear();
  return `${day}/${month}/${year}`;
}

function normalizeDateStr(dateStr) {
  if (!dateStr) return '---';
  const s = String(dateStr).trim();
  
  // Si ya tiene formato DD/MM/YYYY o D/M/YYYY
  if (s.includes('/')) {
    const parsed = parseDayMonthYear(s);
    if (parsed) {
      const day = String(parsed.day).padStart(2, '0');
      const month = String(parsed.month).padStart(2, '0');
      return `${day}/${month}/${parsed.year}`;
    }
  }
  
  // Si tiene formato ISO YYYY-MM-DD o YYYY-MM-DDT...
  if (s.includes('-')) {
    const cleanDate = s.split('T')[0];
    const parts = cleanDate.split('-');
    if (parts.length === 3) {
      const y = parseInt(parts[0], 10);
      const m = parseInt(parts[1], 10);
      const d = parseInt(parts[2], 10);
      if (!isNaN(y) && !isNaN(m) && !isNaN(d)) {
        if (parts[0].length === 4) {
          const day = String(d).padStart(2, '0');
          const month = String(m).padStart(2, '0');
          return `${day}/${month}/${y}`;
        } else if (parts[2].length === 4) {
          const day = String(y).padStart(2, '0');
          const month = String(m).padStart(2, '0');
          return `${day}/${month}/${parts[2]}`;
        }
      }
    }
  }
  
  // Si es un formato ISO o similar, intentar parsear
  try {
    const d = new Date(s);
    if (!isNaN(d.getTime())) {
      const day = String(d.getDate()).padStart(2, '0');
      const month = String(d.getMonth() + 1).padStart(2, '0');
      const year = d.getFullYear();
      return `${day}/${month}/${year}`;
    }
  } catch (e) {
    console.error("Error al normalizar fecha:", dateStr, e);
  }
  
  return s;
}

function normalizeTimeStr(timeStr) {
  if (!timeStr) return '---';
  const s = String(timeStr).trim().toLowerCase();
  
  // Si contiene am/pm o es un formato de texto de hora, y no es un ISO timestamp (que contiene 't')
  if (!s.includes('t') && (s.includes('m') || s.includes(':'))) {
    const match = s.match(/(\d{1,2}):(\d{1,2})(?::(\d{1,2}))?/);
    if (match) {
      let hours = parseInt(match[1], 10);
      const minutes = parseInt(match[2], 10);
      const seconds = match[3] ? parseInt(match[3], 10) : 0;
      
      const isPm = s.includes('p.m.') || s.includes('pm') || s.includes('p. m.');
      const isAm = s.includes('a.m.') || s.includes('am') || s.includes('a. m.');
      
      if (isPm) {
        if (hours < 12) {
          hours += 12;
        }
      } else if (isAm) {
        if (hours === 12) {
          hours = 0;
        }
      }
      
      const hrStr = String(hours).padStart(2, '0');
      const minStr = String(minutes).padStart(2, '0');
      const secStr = String(seconds).padStart(2, '0');
      
      return `${hrStr}:${minStr}:${secStr}`;
    }
  }
  
  // Si es un formato ISO de Apps Script (1899-12-30...), intentar parsear
  try {
    const d = new Date(timeStr);
    if (!isNaN(d.getTime())) {
      const hours = String(d.getHours()).padStart(2, '0');
      const minutes = String(d.getMinutes()).padStart(2, '0');
      const seconds = String(d.getSeconds()).padStart(2, '0');
      return `${hours}:${minutes}:${seconds}`;
    }
  } catch (e) {
    console.error("Error al normalizar hora:", timeStr, e);
  }
  
  return timeStr;
}

function getTimestampFromDateAndTime(dateStr, timeStr) {
  if (!dateStr || !timeStr) return 0;
  const dateParts = dateStr.split('/');
  const timeParts = timeStr.split(':');
  if (dateParts.length === 3 && timeParts.length >= 2) {
    const day = parseInt(dateParts[0], 10);
    const month = parseInt(dateParts[1], 10) - 1; // 0-indexado
    const year = parseInt(dateParts[2], 10);
    const hours = parseInt(timeParts[0], 10);
    const minutes = parseInt(timeParts[1], 10);
    const seconds = timeParts[2] ? parseInt(timeParts[2], 10) : 0;
    
    const d = new Date(year, month, day, hours, minutes, seconds);
    if (!isNaN(d.getTime())) {
      return d.getTime();
    }
  }
  return 0;
}

// Validar si una fecha DD/MM/YYYY está dentro de un rango de inputs date (YYYY-MM-DD)
function isDateInRange(dateStr, startVal, endVal) {
  const parts = dateStr.split('/');
  if (parts.length !== 3) return true;
  const day = parseInt(parts[0], 10);
  const month = parseInt(parts[1], 10) - 1;
  const year = parseInt(parts[2], 10);
  const dateObj = new Date(year, month, day);
  
  if (startVal) {
    const sParts = startVal.split('-');
    const sDate = new Date(sParts[0], sParts[1] - 1, sParts[2]);
    if (dateObj.getTime() < sDate.getTime()) return false;
  }
  
  if (endVal) {
    const eParts = endVal.split('-');
    const eDate = new Date(eParts[0], eParts[1] - 1, eParts[2]);
    if (dateObj.getTime() > eDate.getTime()) return false;
  }
  
  return true;
}

// Convertir hora "HH:MM" a minutos transcurridos
function timeStrToMinutes(timeStr) {
  if (!timeStr) return 0;
  const parts = timeStr.split(':');
  const h = parseInt(parts[0], 10) || 0;
  const m = parseInt(parts[1], 10) || 0;
  return h * 60 + m;
}

// Formatear minutos transcurridos a "Xh Ym"
function formatMinutesToDuration(minutes) {
  if (minutes < 0) minutes = 0;
  const h = Math.floor(minutes / 60);
  const m = Math.round(minutes % 60);
  return `${h}h ${String(m).padStart(2, '0')}m`;
}

// Formatear minutos transcurridos a "HH:MM:SS" (soporta más de 24 horas y diferencias negativas)
function formatMinutesToHHMMSS(minutes) {
  const isNegative = minutes < 0;
  const absMinutes = Math.abs(minutes);
  const h = Math.floor(absMinutes / 60);
  const m = Math.floor(absMinutes % 60);
  const s = 0; // El sistema calcula el tiempo con precisión de minutos
  
  const hStr = String(h).padStart(2, '0');
  const mStr = String(m).padStart(2, '0');
  const sStr = String(s).padStart(2, '0');
  
  return `${isNegative ? '-' : ''}${hStr}:${mStr}:${sStr}`;
}

// Convertir hora "HH:MM:SS" o "HH:MM" a segundos transcurridos
function timeStrToSeconds(timeStr) {
  if (!timeStr) return 0;
  const parts = timeStr.split(':');
  const h = parseInt(parts[0], 10) || 0;
  const m = parseInt(parts[1], 10) || 0;
  const s = parseInt(parts[2], 10) || 0;
  return h * 3600 + m * 60 + s;
}

// Formatear segundos transcurridos a "HH:MM:SS" (soporta más de 24 horas y diferencias negativas)
function formatSecondsToHHMMSS(seconds) {
  const isNegative = seconds < 0;
  const absSeconds = Math.abs(seconds);
  const h = Math.floor(absSeconds / 3600);
  const m = Math.floor((absSeconds % 3600) / 60);
  const s = Math.floor(absSeconds % 60);
  
  const hStr = String(h).padStart(2, '0');
  const mStr = String(m).padStart(2, '0');
  const sStr = String(s).padStart(2, '0');
  
  return `${isNegative ? '-' : ''}${hStr}:${mStr}:${sStr}`;
}

// Lógica para calcular tiempos reales trabajados y breaks por día
function calculateWorkedTimesForDate(historyForDate, config, dateStr) {
  const FERIADOS = [
    "01/01", // Año Nuevo
    "01/05", // Día del Trabajo
    "29/06", // San Pedro y San Pablo
    "23/07", // Día de la Fuerza Aérea
    "28/07", // Fiestas Patrias
    "29/07", // Fiestas Patrias
    "06/08", // Batalla de Junín
    "30/08", // Santa Rosa de Lima
    "08/10", // Combate de Angamos
    "01/11", // Todos los Santos
    "08/12", // Inmaculada Concepción
    "09/12", // Batalla de Ayacucho
    "25/12"  // Navidad
  ];

  let dayOfWeek = 1; // Default: lunes
  if (dateStr) {
    const parts = dateStr.split('/');
    if (parts.length === 3) {
      const day = parseInt(parts[0], 10);
      const month = parseInt(parts[1], 10) - 1;
      const year = parseInt(parts[2], 10);
      const d = new Date(year, month, day);
      if (!isNaN(d.getTime())) {
        dayOfWeek = d.getDay(); // 0 = Domingo, 1 = Lunes, etc.
      }
    }
  }

  // Verificar si es feriado
  let isHoliday = false;
  if (dateStr) {
    const parts = dateStr.split('/');
    if (parts.length >= 2) {
      const dayStr = String(parseInt(parts[0], 10)).padStart(2, '0');
      const monthStr = String(parseInt(parts[1], 10)).padStart(2, '0');
      const dayMonth = `${dayStr}/${monthStr}`;
      isHoliday = GLOBAL_FERIADOS.includes(dayMonth);
    }
    
    // Feriados personalizados (coincidencia de DD/MM/YYYY)
    const normDate = normalizeDateStr(dateStr);
    const customHoliday = feriadosDatabase.find(f => normalizeDateStr(f.dateStr) === normDate);
    if (customHoliday) {
      isHoliday = true;
    }
  }

  // Buscar si hay una justificación para este colaborador y fecha
  let justification = null;
  if (config && config.dni && dateStr) {
    const normDate = normalizeDateStr(dateStr);
    justification = justificacionesDatabase.find(j => 
      String(j.dni) === String(config.dni) && 
      normalizeDateStr(j.dateStr) === normDate
    );
  }

  // Obtener horario diario de la distribución semanal
  let daySched = null;
  const isFlexible = !!(config && (config.workStart === "—" || config.weeklySchedule === "flexible"));
  if (isFlexible) {
    daySched = {
      workStart: "—",
      workEnd: "—",
      expectedHours: 0,
      isRestDay: false,
      nobreak: true,
      isFlexible: true
    };
  } else if (config && config.weeklySchedule) {
    let schedObj = config.weeklySchedule;
    if (typeof schedObj === 'string' && schedObj.trim() !== '') {
      try {
        schedObj = JSON.parse(schedObj);
      } catch (e) {
        schedObj = null;
      }
    }
    if (schedObj && schedObj[dayOfWeek]) {
      daySched = schedObj[dayOfWeek];
    }
  }

  // Fallback si no está configurado en weeklySchedule
  if (!daySched) {
    if (dayOfWeek === 0) {
      // Domingo descanso por defecto
      daySched = {
        workStart: "08:00",
        workEnd: "17:00",
        expectedHours: 0,
        isRestDay: true
      };
    } else if (dayOfWeek === 6) {
      // Sábado por defecto (medio día, sin refrigerio)
      daySched = {
        workStart: config.workStart || "09:00",
        workEnd: "13:00",
        expectedHours: 4,
        isRestDay: false,
        nobreak: true
      };
    } else {
      // Lunes a Viernes por defecto
      daySched = {
        workStart: config.workStart || "08:00",
        workEnd: config.workEnd || "17:00",
        expectedHours: 8,
        isRestDay: false
      };
    }
  }

  // Clonar para evitar mutar el horario original de la distribución
  daySched = JSON.parse(JSON.stringify(daySched));

  const isPartialPerm = justification && justification.type === "Permiso por Horas" && justification.startTime && justification.endTime;
  const isRestDayOrHolidayOrJustified = daySched.isRestDay || isHoliday || (justification && !isPartialPerm);

  let permDurationSecs = 0;
  if (isPartialPerm) {
    const permStartSecs = timeStrToSeconds(justification.startTime);
    const permEndSecs = timeStrToSeconds(justification.endTime);
    permDurationSecs = Math.max(0, permEndSecs - permStartSecs);
    const schedStartSecs = timeStrToSeconds(daySched.workStart || "08:00");
    const schedEndSecs = timeStrToSeconds(daySched.workEnd || "17:00");
    
    // Si el permiso cubre el inicio de la jornada, ajustar el horario de entrada
    if (permStartSecs <= schedStartSecs && permEndSecs > schedStartSecs) {
      daySched.workStart = justification.endTime;
    }
    // Si el permiso cubre el fin de la jornada, ajustar el horario de salida
    if (permEndSecs >= schedEndSecs && permStartSecs < schedEndSecs) {
      daySched.workEnd = justification.startTime;
    }
  }

  const ingresoMark = historyForDate.find(h => h.action === 'Ingreso');
  const breakInMark = historyForDate.find(h => h.action === 'Inicio Refrigerio');
  const breakOutMark = historyForDate.find(h => h.action === 'Fin Refrigerio');
  const salidaMark = historyForDate.find(h => h.action === 'Salida');

  // Si no ingresó
  if (!ingresoMark) {
    return {
      entradaReal: '---',
      breakReal: '---',
      salidaReal: '---',
      breakSeconds: 0,
      workedSeconds: 0,
      status: justification && !isPartialPerm ? justification.type : (isHoliday ? 'Feriado' : (daySched.isRestDay ? 'Descanso' : (isFlexible ? 'No laboró' : 'Falta'))),
      diffSeconds: 0,
      diffClass: daySched.isRestDay || isHoliday || (justification && !isPartialPerm) || isFlexible ? 'diff-neutral' : 'diff-negative',
      tardiness: false,
      breakMinutes: 0,
      workedMinutes: 0,
      excessBreakMinutes: 0,
      excessBreakSeconds: 0,
      hasExcessBreak: false,
      diffMinutes: 0
    };
  }

  const isToday = normalizeDateStr(dateStr) === normalizeDateStr(new Date().toLocaleDateString('es-ES'));
  const entradaReal = ingresoMark.timeStr;
  const salidaReal = salidaMark ? salidaMark.timeStr : (isToday ? 'En curso' : 'Sin salida');
  
  let breakReal = '---';
  let breakSeconds = 0;
  if (breakInMark) {
    if (breakOutMark) {
      breakReal = `${breakInMark.timeStr} → ${breakOutMark.timeStr}`;
      breakSeconds = Math.max(0, Math.floor((breakOutMark.timestamp - breakInMark.timestamp) / 1000));
    } else {
      if (isToday) {
        breakReal = `${breakInMark.timeStr} → En curso`;
        breakSeconds = Math.max(0, Math.floor((Date.now() - breakInMark.timestamp) / 1000));
      } else {
        breakReal = `${breakInMark.timeStr} → Sin fin`;
        breakSeconds = 0;
      }
    }
  }

  // Detectar si la salida fue autocompletada por omisión
  const isAutoClose = salidaMark && (
    (salidaMark.details && (
      salidaMark.details.includes('Autocompletado') || 
      salidaMark.details.includes('Autocompletado por omisión') ||
      salidaMark.details.includes('Cierre automático')
    )) || 
    salidaMark.timeStr === '23:59:59' ||
    salidaMark.timeStr === '23:59:58'
  );

  let adjustedSalidaTimestamp = salidaMark ? salidaMark.timestamp : null;

  let effectiveIngresoTimestamp = ingresoMark.timestamp;
  if (!isFlexible && !isRestDayOrHolidayOrJustified) {
    const startStr = daySched.workStart || "08:00";
    const [startHour, startMin] = startStr.split(':').map(Number);
    const expectedStartDateObj = new Date(ingresoMark.timestamp);
    expectedStartDateObj.setHours(startHour, startMin, 0, 0);
    const expectedStartTimestamp = expectedStartDateObj.getTime();

    // Si el agente marca antes del horario programado, se le cuenta a partir de la hora de inicio programada
    if (ingresoMark.timestamp < expectedStartTimestamp) {
      effectiveIngresoTimestamp = expectedStartTimestamp;
    }
  }

  let totalElapsedSeconds = 0;
  if (salidaMark) {
    totalElapsedSeconds = Math.max(0, Math.floor((adjustedSalidaTimestamp - effectiveIngresoTimestamp) / 1000));
  } else if (isToday) {
    totalElapsedSeconds = Math.max(0, Math.floor((Date.now() - effectiveIngresoTimestamp) / 1000));
  } else {
    const lastMark = historyForDate[historyForDate.length - 1];
    totalElapsedSeconds = Math.max(0, Math.floor((lastMark.timestamp - effectiveIngresoTimestamp) / 1000));
  }

  let workedSeconds = Math.max(0, totalElapsedSeconds - breakSeconds);
  if (isPartialPerm && justification.compensation !== 'Sin goce') {
    workedSeconds += permDurationSecs;
  }

  // Expectativas teóricas
  let expectedWorkSeconds = 0;
  let expectedBreakSeconds = 0;

  if (isFlexible) {
    expectedWorkSeconds = 0;
    expectedBreakSeconds = 0;
    if (isAutoClose) {
      // Cierre automático: capar a un máximo de 8 horas para flexible
      workedSeconds = Math.min(workedSeconds, 28800);
    }
  } else {
    const expectedStart = timeStrToSeconds(daySched.workStart || "08:00");
    const expectedEnd = timeStrToSeconds(daySched.workEnd || "17:00");
    const totalShiftSeconds = Math.max(0, expectedEnd - expectedStart);
    expectedWorkSeconds = isRestDayOrHolidayOrJustified ? 0 : Math.max(0, (daySched.expectedHours || 8) * 3600);
    if (isPartialPerm && justification.compensation === 'Sin goce') {
      expectedWorkSeconds = Math.max(0, expectedWorkSeconds - permDurationSecs);
    }
    expectedBreakSeconds = isRestDayOrHolidayOrJustified || daySched.nobreak ? 0 : Math.max(0, totalShiftSeconds - expectedWorkSeconds);

    if (isAutoClose) {
      if (isRestDayOrHolidayOrJustified) {
        workedSeconds = 0;
      } else {
        // Simular salida teórica para penalizar tardanzas pero no generar horas extras
        const actualEntrySecs = timeStrToSeconds(entradaReal);
        const calcStartSecs = Math.max(actualEntrySecs, expectedStart);
        const calculatedElapsed = Math.max(0, expectedEnd - calcStartSecs);
        
        workedSeconds = Math.max(0, calculatedElapsed - breakSeconds);
        if (workedSeconds > expectedWorkSeconds) {
          workedSeconds = expectedWorkSeconds;
        }
      }
    }
  }

  let diffSeconds = 0;
  let diffClass = 'diff-neutral';
  let status = '---';

  if (isFlexible) {
    status = '00:00:00';
    diffSeconds = 0;
    diffClass = 'diff-neutral';
  } else if (isRestDayOrHolidayOrJustified) {
    // En día de descanso, feriado o justificado, todas las horas trabajadas son a favor (horas extra)
    if (salidaMark) {
      diffSeconds = isAutoClose ? 0 : workedSeconds;
      if (diffSeconds > 0) {
        status = `+${formatSecondsToHHMMSS(diffSeconds)}`;
        diffClass = 'diff-positive';
      } else {
        status = '00:00:00';
        diffClass = 'diff-neutral';
      }
    } else {
      status = '--';
      diffClass = 'diff-neutral';
    }
  } else {
    // Día laboral normal
    if (salidaMark) {
      diffSeconds = workedSeconds - expectedWorkSeconds;
      if (isAutoClose && diffSeconds > 0) {
        diffSeconds = 0;
      }
      
      if (diffSeconds > 0) {
        status = `+${formatSecondsToHHMMSS(diffSeconds)}`;
        diffClass = 'diff-positive';
      } else if (diffSeconds < 0) {
        status = `${formatSecondsToHHMMSS(diffSeconds)}`;
        diffClass = 'diff-negative';
      } else {
        status = '00:00:00';
        diffClass = 'diff-neutral';
      }
    } else {
      status = '--';
      diffClass = 'diff-neutral';
    }
  }

  // Evaluar tardanza (entradaReal vs workStart + tolerancia) - No aplica en flexible, descanso, feriado o justificado
  let tardiness = false;
  let tardinessSeconds = 0;
  if (!isFlexible && !isRestDayOrHolidayOrJustified) {
    const actualEntrySeconds = timeStrToSeconds(entradaReal);
    const scheduledEntrySeconds = timeStrToSeconds(daySched.workStart || "08:00");
    tardiness = actualEntrySeconds > (scheduledEntrySeconds + (tardinessTolerance * 60));
    if (actualEntrySeconds > scheduledEntrySeconds) {
      tardinessSeconds = actualEntrySeconds - scheduledEntrySeconds;
    }
  }

  // Evaluar horas adicionales (overtime en día laborable normal) - No aplica en flexible
  let horasAdicionalesSeconds = 0;
  if (!isFlexible && !isRestDayOrHolidayOrJustified && salidaMark && !isAutoClose) {
    const actualExitSeconds = timeStrToSeconds(salidaReal);
    const scheduledExitSeconds = timeStrToSeconds(daySched.workEnd || "17:00");
    if (actualExitSeconds > scheduledExitSeconds) {
      horasAdicionalesSeconds = actualExitSeconds - scheduledExitSeconds;
    }
  }

  // Evaluar exceso de break - No aplica en flexible o sin descanso
  let excessBreakSeconds = 0;
  let hasExcessBreak = false;
  if (!isFlexible && !isRestDayOrHolidayOrJustified && !daySched.nobreak && breakSeconds > expectedBreakSeconds) {
    excessBreakSeconds = breakSeconds - expectedBreakSeconds;
    hasExcessBreak = true;
  }

  const breakMinutes = Math.floor(breakSeconds / 60);
  const workedMinutes = Math.floor(workedSeconds / 60);
  const excessBreakMinutes = Math.floor(excessBreakSeconds / 60);
  const diffMinutes = Math.floor(diffSeconds / 60);

  const entradaDevice = ingresoMark && ingresoMark.device ? ingresoMark.device : '---';
  const salidaDevice = salidaMark && salidaMark.device ? salidaMark.device : '---';

  return {
    entradaReal,
    breakReal,
    salidaReal,
    breakSeconds,
    workedSeconds,
    status,
    diffSeconds,
    diffClass,
    tardiness,
    tardinessSeconds,
    horasAdicionalesSeconds,
    breakMinutes,
    workedMinutes,
    excessBreakMinutes,
    diffMinutes,
    hasExcessBreak,
    excessBreakSeconds,
    entradaDevice,
    salidaDevice
  };
}

// Función reutilizable para actualizar el resumen de horario según una fecha de referencia
function updateScheduleSummary(employee, referenceDate, dateLabel) {
  const summaryDiv = document.getElementById('report-schedule-summary');
  if (!summaryDiv || !employee) return;

  const isFlexible = (employee.workStart === "—" || employee.weeklySchedule === "flexible");
  if (isFlexible) {
    summaryDiv.innerHTML = `
      <div class="report-schedule-item" style="grid-column: span 4; text-align: center; padding: 15px;">
        <h4 style="font-size: 0.9rem; color: var(--text-muted); text-transform: uppercase;">Modalidad de Jornada</h4>
        <p style="font-size: 1.15rem; font-weight: 600; color: var(--color-blue); margin-top: 8px;">
          <span class="material-symbols-rounded" style="vertical-align: middle; margin-right: 5px; font-size: 20px;">tune</span>
          Horario Flexible / Sin Horario Programado
        </p>
        <span style="font-size: 0.8rem; color: var(--text-secondary); display: block; margin-top: 6px;">El colaborador marca asistencia libremente sin control de tardanzas ni límites de turno fijo.</span>
      </div>
    `;
    return;
  }

  let schedObj = employee.weeklySchedule;
  if (typeof schedObj === 'string' && schedObj.trim() !== '') {
    try { schedObj = JSON.parse(schedObj); } catch(e) { schedObj = null; }
  }
  if (!schedObj) schedObj = {};

  const refDow = referenceDate.getDay();
  const todayDow = new Date().getDay();
  const dayLabels = ['Dom', 'Lun', 'Mar', 'Mié', 'Jue', 'Vie', 'Sáb'];
  const dayNamesFull = ['Domingo', 'Lunes', 'Martes', 'Miércoles', 'Jueves', 'Viernes', 'Sábado'];

  // Determinar si la fecha de referencia es hoy
  const todayObj = new Date();
  todayObj.setHours(0,0,0,0);
  const refObj = new Date(referenceDate);
  refObj.setHours(0,0,0,0);
  const isRefToday = refObj.getTime() === todayObj.getTime();

  // Etiqueta para los encabezados
  const headerSuffix = isRefToday ? 'Hoy' : (dateLabel || dayNamesFull[refDow]);

  // Helper para obtener horario de un día
  function getSchedForDay(dow) {
    let ds = schedObj[dow] || null;
    if (!ds) {
      if (dow === 0) ds = { isRestDay: true, workStart: "---", workEnd: "---", expectedHours: 0 };
      else if (dow === 6) ds = { isRestDay: false, workStart: employee.workStart || "09:00", workEnd: "13:00", expectedHours: 4, nobreak: true };
      else ds = { isRestDay: false, workStart: employee.workStart || "08:00", workEnd: employee.workEnd || "17:00", expectedHours: 8 };
    }
    return ds;
  }

  // Construir tabla resumen de distribución semanal
  let scheduleRows = '';
  for (let d = 1; d <= 6; d++) { // Lun(1) a Sáb(6)
    const ds = getSchedForDay(d);
    const isRef = refDow === d;
    const isToday = todayDow === d;
    const highlight = isRef ? 'background: rgba(99, 102, 241, 0.08); border-radius: 6px; font-weight: 600;' : '';
    
    let badge = '';
    if (isRef && isRefToday) {
      badge = '<span style="font-size: 0.6rem; background: var(--gradient-1); color: white; padding: 1px 6px; border-radius: 10px; margin-left: 4px;">HOY</span>';
    } else if (isRef) {
      badge = '<span style="font-size: 0.6rem; background: #6366f1; color: white; padding: 1px 6px; border-radius: 10px; margin-left: 4px;">FILTRO</span>';
    } else if (isToday) {
      badge = '<span style="font-size: 0.6rem; background: rgba(99,102,241,0.2); color: #6366f1; padding: 1px 6px; border-radius: 10px; margin-left: 4px;">HOY</span>';
    }

    if (ds.isRestDay) {
      scheduleRows += `<div style="display: flex; justify-content: space-between; align-items: center; padding: 4px 8px; ${highlight}">
        <span style="font-size: 0.8rem; color: var(--text-secondary);">${dayLabels[d]}${badge}</span>
        <span style="font-size: 0.8rem; color: var(--text-muted); font-style: italic;">Descanso</span>
      </div>`;
    } else {
      scheduleRows += `<div style="display: flex; justify-content: space-between; align-items: center; padding: 4px 8px; ${highlight}">
        <span style="font-size: 0.8rem; color: var(--text-secondary);">${dayLabels[d]}${badge}</span>
        <span style="font-size: 0.8rem; color: var(--text-primary);">${ds.workStart || "08:00"} → ${ds.workEnd || "17:00"} (${ds.expectedHours || 8}h)</span>
      </div>`;
    }
  }
  // Domingo
  const domDs = getSchedForDay(0);
  const isDomRef = refDow === 0;
  const isDomToday = todayDow === 0;
  const domHighlight = isDomRef ? 'background: rgba(99, 102, 241, 0.08); border-radius: 6px; font-weight: 600;' : '';
  let domBadge = '';
  if (isDomRef && isRefToday) {
    domBadge = '<span style="font-size: 0.6rem; background: var(--gradient-1); color: white; padding: 1px 6px; border-radius: 10px; margin-left: 4px;">HOY</span>';
  } else if (isDomRef) {
    domBadge = '<span style="font-size: 0.6rem; background: #6366f1; color: white; padding: 1px 6px; border-radius: 10px; margin-left: 4px;">FILTRO</span>';
  } else if (isDomToday) {
    domBadge = '<span style="font-size: 0.6rem; background: rgba(99,102,241,0.2); color: #6366f1; padding: 1px 6px; border-radius: 10px; margin-left: 4px;">HOY</span>';
  }
  if (domDs.isRestDay) {
    scheduleRows += `<div style="display: flex; justify-content: space-between; align-items: center; padding: 4px 8px; ${domHighlight}">
      <span style="font-size: 0.8rem; color: var(--text-secondary);">Dom${domBadge}</span>
      <span style="font-size: 0.8rem; color: var(--text-muted); font-style: italic;">Descanso</span>
    </div>`;
  } else {
    scheduleRows += `<div style="display: flex; justify-content: space-between; align-items: center; padding: 4px 8px; ${domHighlight}">
      <span style="font-size: 0.8rem; color: var(--text-secondary);">Dom${domBadge}</span>
      <span style="font-size: 0.8rem; color: var(--text-primary);">${domDs.workStart || "08:00"} → ${domDs.workEnd || "17:00"} (${domDs.expectedHours || 8}h)</span>
    </div>`;
  }

  // Obtener horario de la fecha de referencia para resumen principal
  const refSched = getSchedForDay(refDow);
  const refEntrada = refSched.isRestDay ? 'Descanso' : (refSched.workStart || "08:00");
  const refSalida = refSched.isRestDay ? 'Descanso' : (refSched.workEnd || "17:00");
  // Calcular jornada total (entrada a salida) en HH:MM
  let jornadaDisplay = 'Descanso';
  if (!refSched.isRestDay) {
    const startMin = timeStrToMinutes(refSched.workStart || "08:00");
    const endMin = timeStrToMinutes(refSched.workEnd || "17:00");
    const totalMin = Math.max(0, endMin - startMin);
    const hh = String(Math.floor(totalMin / 60)).padStart(2, '0');
    const mm = String(totalMin % 60).padStart(2, '0');
    jornadaDisplay = `${hh}:${mm}`;
  }


  // Formatear la fecha de referencia para mostrar
  const refDateStr = referenceDate.toLocaleDateString('es-PE', { day: '2-digit', month: '2-digit', year: 'numeric' });
  const dateInfo = isRefToday ? '' : `<span style="font-size: 0.65rem; color: var(--text-muted); display: block; margin-top: 2px;">${refDateStr} (${dayNamesFull[refDow]})</span>`;

  summaryDiv.innerHTML = `
    <div class="report-schedule-item">
      <h4>Entrada ${headerSuffix}</h4>
      <p>${refEntrada}</p>
      ${dateInfo}
    </div>
    <div class="report-schedule-item">
      <h4>Salida ${headerSuffix}</h4>
      <p>${refSalida}</p>
      ${dateInfo ? '' : ''}
    </div>
    <div class="report-schedule-item">
      <h4>Refrigerio</h4>
      <p>${refSched.isRestDay || refSched.nobreak ? 'N/A' : ((employee.breakStart || "13:00") + ' a ' + (employee.breakEnd || "14:00"))}</p>
    </div>
    <div class="report-schedule-item">
      <h4>Jornada ${headerSuffix}</h4>
      <p>${jornadaDisplay}</p>
    </div>
  `;
}

// Poblar dropdown de selección para el reporte
function updateReportEmployeeSelect() {

  const select = document.getElementById('select-report-employee');
  const justSelect = document.getElementById('just-employee');
  
  if (select) {
    const currentVal = select.value;
    select.innerHTML = '<option value="" disabled selected hidden>Seleccionar colaborador...</option>';
    
    const optAll = document.createElement('option');
    optAll.value = "all";
    optAll.textContent = "[Todos los Colaboradores]";
    select.appendChild(optAll);
    
    Object.keys(employeesDatabase).forEach(dni => {
      const employee = employeesDatabase[dni];
      // Si el reporte es 'justSelect', no mostrar inactivos.
      if (!isEmployeeActive(employee)) return;
      
      const opt = document.createElement('option');
      opt.value = dni;
      opt.textContent = `${employee.name} (DNI: ${dni})`;
      select.appendChild(opt);
    });
    if (currentVal && employeesDatabase[currentVal]) {
      select.value = currentVal;
    }
  }

  if (justSelect) {
    const currentJustVal = justSelect.value;
    justSelect.innerHTML = '<option value="" disabled selected hidden>Seleccionar colaborador...</option>';
    Object.keys(employeesDatabase).forEach(dni => {
      const employee = employeesDatabase[dni];
      if (!isEmployeeActive(employee)) return;
      
      const opt = document.createElement('option');
      opt.value = dni;
      opt.textContent = `${employee.name} (DNI: ${dni})`;
      justSelect.appendChild(opt);
    });
    if (currentJustVal && employeesDatabase[currentJustVal]) {
      justSelect.value = currentJustVal;
    }
  }
}

// Obtener el historial completo consolidado desde el cache local (Optimizado O(N))
function getAllCachedHistory() {
  const history = [];
  const seenKeys = new Set();
  
  Object.keys(employeesDatabase).forEach(dni => {
    const cleanEmpDni = String(dni).replace(/'/g, '').trim();
    if (attendanceState[dni] && Array.isArray(attendanceState[dni].history)) {
      attendanceState[dni].history.forEach(item => {
        const itemDni = String(item.dni || cleanEmpDni).replace(/'/g, '').trim();
        const key = `${itemDni}_${item.timestamp}_${item.action}`;
        if (!seenKeys.has(key)) {
          seenKeys.add(key);
          history.push({ ...item, dni: itemDni });
        }
      });
    }
  });

  if (Array.isArray(globalLogs)) {
    globalLogs.forEach(item => {
      const cleanDni = String(item.dni || '').replace(/'/g, '').trim();
      if (!cleanDni) return;
      const key = `${cleanDni}_${item.timestamp}_${item.action}`;
      if (!seenKeys.has(key)) {
        seenKeys.add(key);
        history.push({ ...item, dni: cleanDni });
      }
    });
  }

  return history;
}

// Renderizar tabla de reportes históricos del colaborador seleccionado
function renderAgentReport(dni) {
  const tbody = document.getElementById('admin-report-table-body');
  const summaryDiv = document.getElementById('report-schedule-summary');
  if (!tbody || !summaryDiv) return;

  if (dni === "all") {
    // Configurar título del reporte
    const titleDiv = document.getElementById('report-employee-title');
    const nameDisplay = document.getElementById('report-employee-name-display');
    if (titleDiv && nameDisplay) {
      nameDisplay.textContent = "Todos los Colaboradores";
      titleDiv.classList.remove('hidden');
    }

    // Cabecera formal
    const printName = document.getElementById('print-emp-name');
    const printDni = document.getElementById('print-emp-dni');
    const printRole = document.getElementById('print-emp-role');
    if (printName && printDni && printRole) {
      printName.textContent = "Todos los Colaboradores";
      printDni.textContent = "TODOS";
      printRole.textContent = "VARIOS";
    }

    // Ocultar resumen de un solo colaborador
    summaryDiv.style.display = 'none';

    // Consolidar historial
    const allHistory = [];
    Object.keys(employeesDatabase).forEach(empDni => {
      const state = attendanceState[empDni] || { history: [] };
      (state.history || []).forEach(item => {
        allHistory.push({ ...item, dni: empDni });
      });
    });

    cachedAgentHistory = allHistory;
    renderReportTable(cachedAgentHistory, "all");
    return;
  }

  // Mostrar el resumen del horario para un agente específico
  summaryDiv.style.display = 'flex';

  const employee = employeesDatabase[dni];
  if (!employee) {
    tbody.innerHTML = '<tr><td colspan="9" class="text-center text-muted" style="padding: 25px;">Colaborador no encontrado.</td></tr>';
    return;
  }

  // Mostrar título del colaborador en el reporte para visualización y PDF
  const titleDiv = document.getElementById('report-employee-title');
  const nameDisplay = document.getElementById('report-employee-name-display');
  if (titleDiv && nameDisplay) {
    nameDisplay.textContent = `${employee.name} (DNI: ${dni}) - ${employee.role}`;
    titleDiv.classList.remove('hidden');
  }

  // Rellenar cabecera de impresión formal
  const printName = document.getElementById('print-emp-name');
  const printDni = document.getElementById('print-emp-dni');
  const printRole = document.getElementById('print-emp-role');
  if (printName && printDni && printRole) {
    printName.textContent = employee.name;
    printDni.textContent = dni;
    printRole.textContent = employee.role;
  }

  // Mostrar resumen de horario del día actual al cargar
  updateScheduleSummary(employee, new Date());

  const state = attendanceState[dni] || { history: [] };
  cachedAgentHistory = state.history || [];
  renderReportTable(cachedAgentHistory, employee);
}

// Función auxiliar para construir la tabla del reporte
function renderReportTable(history, employee) {
  const tbody = document.getElementById('admin-report-table-body');
  const thead = document.querySelector('#tab-reports-content table thead');
  if (!tbody || !thead) return;

  const isAll = (employee === "all");

  if (!history || history.length === 0) {
    tbody.innerHTML = '<tr><td colspan="9" class="text-center text-muted" style="padding: 25px;">No se registran marcas de asistencia históricas.</td></tr>';
    return;
  }

  // Las cabeceras siempre son las mismas 9 columnas originales (Cabecera Estática)
  thead.innerHTML = `
    <tr>
      <th>Fecha</th>
      <th class="text-center">Entrada</th>
      <th class="text-center">Tardanza</th>
      <th class="text-center">Refrigerio (Inicio &rarr; Fin)</th>
      <th class="text-center">Salida</th>
      <th class="text-center">Horas Adicionales</th>
      <th class="text-center">Refrigerio (Total)</th>
      <th class="text-center">Trabajo Real</th>
      <th class="text-center">Diferencia</th>
    </tr>
  `;

  // Normalizar marcas del historial y calcular timestamps
  const normalizedHistory = history.map(item => {
    const normDate = normalizeDateStr(item.dateStr);
    const normTime = normalizeTimeStr(item.timeStr);
    const ts = getTimestampFromDateAndTime(normDate, normTime);
    return {
      ...item,
      dateStr: normDate,
      timeStr: normTime,
      timestamp: ts
    };
  });

  // Filtrar por rango de fechas
  const startDate = document.getElementById('report-start-date')?.value || '';
  const endDate = document.getElementById('report-end-date')?.value || '';
  
  const filteredHistory = normalizedHistory.filter(item => {
    return isDateInRange(item.dateStr, startDate, endDate);
  });

  if (filteredHistory.length === 0) {
    tbody.innerHTML = '<tr><td colspan="9" class="text-center text-muted" style="padding: 25px;">No hay marcas en el rango de fechas seleccionado.</td></tr>';
    return;
  }

  // Actualizar resumen de horario superior (solo para agente único)
  if (!isAll) {
    if (startDate) {
      const parts = startDate.split('-');
      if (parts.length === 3) {
        const refDate = new Date(parseInt(parts[0]), parseInt(parts[1]) - 1, parseInt(parts[2]));
        if (!isNaN(refDate.getTime())) {
          if (startDate === endDate || !endDate) {
            updateScheduleSummary(employee, refDate);
          } else {
            updateScheduleSummary(employee, refDate, 'Desde');
          }
        }
      }
    } else {
      updateScheduleSummary(employee, new Date());
    }
  }

  tbody.innerHTML = '';

  if (isAll) {
    // MODO TODOS: Agrupar historial por DNI
    const historyByEmployee = {};
    filteredHistory.forEach(item => {
      if (!historyByEmployee[item.dni]) {
        historyByEmployee[item.dni] = [];
      }
      historyByEmployee[item.dni].push(item);
    });

    // Ordenar colaboradores alfabéticamente
    const sortedDnis = Object.keys(historyByEmployee).sort((a, b) => {
      const nameA = employeesDatabase[a]?.name || '';
      const nameB = employeesDatabase[b]?.name || '';
      return nameA.localeCompare(nameB);
    });

    // Renderizar grupo por colaborador
    sortedDnis.forEach(empDni => {
      const emp = employeesDatabase[empDni];
      if (!emp) return;

      const empHistory = historyByEmployee[empDni];

      // Agrupar marcas de este colaborador por fecha
      const groupedByDate = {};
      empHistory.forEach(item => {
        if (!groupedByDate[item.dateStr]) groupedByDate[item.dateStr] = [];
        groupedByDate[item.dateStr].push(item);
      });

      // Ordenar fechas descendente
      const sortedDates = Object.keys(groupedByDate).sort((a, b) => {
        const partsA = a.split('/');
        const partsB = b.split('/');
        const dateA = new Date(partsA[2], partsA[1] - 1, partsA[0]);
        const dateB = new Date(partsB[2], partsB[1] - 1, partsB[0]);
        return dateB - dateA;
      });

      // Calcular Totales
      let totalWorkedSecs = 0;
      let totalTardySecs = 0;
      let totalOvertimeSecs = 0;
      let totalBreakSecs = 0;
      let totalDiffSecs = 0;

      const empReports = [];
      sortedDates.forEach(dateStr => {
        const dayMarks = groupedByDate[dateStr].sort((a, b) => a.timestamp - b.timestamp);
        const report = calculateWorkedTimesForDate(dayMarks, emp, dateStr);
        empReports.push({ dateStr, report });

        totalWorkedSecs += report.workedSeconds;
        totalTardySecs += report.tardinessSeconds;
        totalOvertimeSecs += report.horasAdicionalesSeconds;
        totalBreakSecs += report.breakSeconds;
        totalDiffSecs += report.diffSeconds;
      });

      // Añadir fila resumen del colaborador (Colapsada por defecto)
      const scheduledBreakStr = `	h${emp.breakStart || "13:00"} - ${emp.breakEnd || "14:00"}`.replace('\t', '');
      const summaryTr = document.createElement('tr');
      summaryTr.classList.add('summary-row');
      summaryTr.setAttribute('data-emp-dni', empDni);
      summaryTr.style.backgroundColor = 'var(--bg-secondary)';
      summaryTr.style.fontWeight = '700';
      summaryTr.style.cursor = 'pointer';
      
      summaryTr.innerHTML = `
        <td style="color: var(--text-primary); text-transform: uppercase; font-weight: 700; display: flex; align-items: center; gap: 6px; border-bottom: none; font-size: 0.8rem; line-height: 1.2;">
          <span class="material-symbols-rounded toggle-icon" style="font-size: 18px; transition: transform 0.2s; color: var(--text-secondary);">chevron_right</span>
          <span>${emp.name}</span>
        </td>
        <td class="text-center" style="font-weight: 700; color: var(--text-primary);">${emp.workStart || "08:00"}</td>
        <td class="text-center" style="color: #ff4d4d; font-weight: 700;">${totalTardySecs > 0 ? formatSecondsToHHMMSS(totalTardySecs) : '00:00:00'}</td>
        <td class="text-center" style="font-weight: 700; color: var(--text-primary);">${scheduledBreakStr}</td>
        <td class="text-center" style="font-weight: 700; color: var(--text-primary);">${emp.workEnd || "18:00"}</td>
        <td class="text-center" style="font-weight: 700; color: var(--text-primary);">${totalOvertimeSecs > 0 ? formatSecondsToHHMMSS(totalOvertimeSecs) : '00:00:00'}</td>
        <td class="text-center" style="font-weight: 700; color: var(--text-primary);">${totalBreakSecs > 0 ? formatSecondsToHHMMSS(totalBreakSecs) : '00:00:00'}</td>
        <td class="text-center" style="font-weight: 700; color: var(--text-primary);">${totalWorkedSecs > 0 ? formatSecondsToHHMMSS(totalWorkedSecs) : '00:00:00'}</td>
        <td class="text-center">
          <span class="${totalDiffSecs > 0 ? 'diff-positive' : (totalDiffSecs < 0 ? 'diff-negative' : 'diff-neutral')}">
            ${totalDiffSecs > 0 ? '+' : ''}${formatSecondsToHHMMSS(totalDiffSecs)}
          </span>
        </td>
      `;
      tbody.appendChild(summaryTr);

      // Renderizar días individuales (Ocultos por defecto)
      empReports.forEach(({ dateStr, report }) => {
        const excessBreakBadge = report.hasExcessBreak 
          ? `<span class="badge-excess-break"><span class="material-symbols-rounded">warning</span>Exceso: ${report.excessBreakMinutes}m</span>` 
          : '';

        const tr = document.createElement('tr');
        tr.classList.add(`history-row-emp-${empDni}`);
        tr.style.display = 'none'; // oculto al inicio en modo Todos
        tr.innerHTML = `
          <td style="font-weight: 600; padding-left: 24px;">${dateStr}</td>
          <td class="table-timestamp text-center" style="white-space: nowrap;">${report.entradaReal}${getDeviceIconShortHTML(report.entradaDevice)}</td>
          <td class="text-center" style="white-space: nowrap; ${report.tardinessSeconds > 0 ? 'color: #ff4d4d; font-weight: 600;' : ''}">${report.tardinessSeconds > 0 ? formatSecondsToHHMMSS(report.tardinessSeconds) : '00:00:00'}</td>
          <td class="text-center" style="white-space: nowrap;">${report.breakReal}</td>
          <td class="table-timestamp text-center" style="white-space: nowrap;">${report.salidaReal}${getDeviceIconShortHTML(report.salidaDevice)}</td>
          <td class="text-center" style="white-space: nowrap;">${report.horasAdicionalesSeconds > 0 ? formatSecondsToHHMMSS(report.horasAdicionalesSeconds) : '00:00:00'}</td>
          <td class="text-center" style="white-space: nowrap;">${report.breakSeconds > 0 ? formatSecondsToHHMMSS(report.breakSeconds) : '00:00:00'}${excessBreakBadge}</td>
          <td class="text-center" style="font-weight: 600; color: var(--text-primary); white-space: nowrap;">${report.workedSeconds > 0 ? formatSecondsToHHMMSS(report.workedSeconds) : '00:00:00'}</td>
          <td class="text-center" style="white-space: nowrap;">
            <span class="${report.diffClass}">${report.status}</span>
          </td>
        `;
        tbody.appendChild(tr);
      });
    });

  } else {
    // MODO INDIVIDUAL: Agrupar por fecha
    const groupedByDate = {};
    filteredHistory.forEach(item => {
      if (!groupedByDate[item.dateStr]) groupedByDate[item.dateStr] = [];
      groupedByDate[item.dateStr].push(item);
    });

    const sortedDates = Object.keys(groupedByDate).sort((a, b) => {
      const partsA = a.split('/');
      const partsB = b.split('/');
      const dateA = new Date(partsA[2], partsA[1] - 1, partsA[0]);
      const dateB = new Date(partsB[2], partsB[1] - 1, partsB[0]);
      return dateB - dateA;
    });

    // Calcular Totales individuales
    let totalWorkedSecs = 0;
    let totalTardySecs = 0;
    let totalOvertimeSecs = 0;
    let totalBreakSecs = 0;
    let totalDiffSecs = 0;

    sortedDates.forEach(dateStr => {
      const dayMarks = groupedByDate[dateStr].sort((a, b) => a.timestamp - b.timestamp);
      const report = calculateWorkedTimesForDate(dayMarks, employee, dateStr);
      totalWorkedSecs += report.workedSeconds;
      totalTardySecs += report.tardinessSeconds;
      totalOvertimeSecs += report.horasAdicionalesSeconds;
      totalBreakSecs += report.breakSeconds;
      totalDiffSecs += report.diffSeconds;
    });

    // Insertar fila de Resumen y Horario Programado (Abierta por defecto en modo individual)
    const scheduledBreakStr = `${employee.breakStart || "13:00"} - ${employee.breakEnd || "14:00"}`;
    const summaryRowHtml = `
      <tr class="summary-row expanded-group" data-emp-dni="${employee.dni}" style="background-color: var(--bg-secondary) !important; font-weight: 700; cursor: pointer;">
        <td style="color: var(--text-primary); text-transform: uppercase; display: flex; align-items: center; gap: 6px; border-bottom: none; font-weight: 700; font-size: 0.8rem; line-height: 1.2;">
          <span class="material-symbols-rounded toggle-icon" style="font-size: 18px; transition: transform 0.2s; color: var(--text-secondary); transform: rotate(90deg);">chevron_right</span>
          <span>${employee.name}</span>
        </td>
        <td class="text-center" style="font-weight: 700; color: var(--text-primary);">${employee.workStart || "08:00"}</td>
        <td class="text-center" style="color: #ff4d4d; font-weight: 700;">${totalTardySecs > 0 ? formatSecondsToHHMMSS(totalTardySecs) : '00:00:00'}</td>
        <td class="text-center" style="font-weight: 700; color: var(--text-primary);">${scheduledBreakStr}</td>
        <td class="text-center" style="font-weight: 700; color: var(--text-primary);">${employee.workEnd || "18:00"}</td>
        <td class="text-center" style="font-weight: 700; color: var(--text-primary);">${totalOvertimeSecs > 0 ? formatSecondsToHHMMSS(totalOvertimeSecs) : '00:00:00'}</td>
        <td class="text-center" style="font-weight: 700; color: var(--text-primary);">${totalBreakSecs > 0 ? formatSecondsToHHMMSS(totalBreakSecs) : '00:00:00'}</td>
        <td class="text-center" style="font-weight: 700; color: var(--text-primary);">${totalWorkedSecs > 0 ? formatSecondsToHHMMSS(totalWorkedSecs) : '00:00:00'}</td>
        <td class="text-center">
          <span class="${totalDiffSecs > 0 ? 'diff-positive' : (totalDiffSecs < 0 ? 'diff-negative' : 'diff-neutral')} shadow-glow">
            ${totalDiffSecs > 0 ? '+' : ''}${formatSecondsToHHMMSS(totalDiffSecs)}
          </span>
        </td>
      </tr>
    `;
    tbody.innerHTML = summaryRowHtml;

    // Renderizar registros individuales
    sortedDates.forEach(dateStr => {
      const dayMarks = groupedByDate[dateStr].sort((a, b) => a.timestamp - b.timestamp);
      const report = calculateWorkedTimesForDate(dayMarks, employee, dateStr);
      
      const excessBreakBadge = report.hasExcessBreak 
        ? `<span class="badge-excess-break"><span class="material-symbols-rounded">warning</span>Exceso: ${report.excessBreakMinutes}m</span>` 
        : '';

      const tr = document.createElement('tr');
      tr.classList.add(`history-row-emp-${employee.dni}`); // agregamos clase para poder colapsar individual también
      tr.innerHTML = `
        <td style="font-weight: 600; padding-left: 24px;">${dateStr}</td>
        <td class="table-timestamp text-center" style="white-space: nowrap;">${report.entradaReal}${getDeviceIconShortHTML(report.entradaDevice)}</td>
        <td class="text-center" style="white-space: nowrap; ${report.tardinessSeconds > 0 ? 'color: #ff4d4d; font-weight: 600;' : ''}">${report.tardinessSeconds > 0 ? formatSecondsToHHMMSS(report.tardinessSeconds) : '00:00:00'}</td>
        <td class="text-center" style="white-space: nowrap;">${report.breakReal}</td>
        <td class="table-timestamp text-center" style="white-space: nowrap;">${report.salidaReal}${getDeviceIconShortHTML(report.salidaDevice)}</td>
        <td class="text-center" style="white-space: nowrap;">${report.horasAdicionalesSeconds > 0 ? formatSecondsToHHMMSS(report.horasAdicionalesSeconds) : '00:00:00'}</td>
        <td class="text-center" style="white-space: nowrap;">${report.breakSeconds > 0 ? formatSecondsToHHMMSS(report.breakSeconds) : '00:00:00'}<!--=-->${excessBreakBadge}</td>
        <td class="text-center" style="font-weight: 600; color: var(--text-primary); white-space: nowrap;">${report.workedSeconds > 0 ? formatSecondsToHHMMSS(report.workedSeconds) : '00:00:00'}</td>
        <td class="text-center" style="white-space: nowrap;">
          <span class="${report.diffClass}">${report.status}</span>
        </td>
      `;
      tbody.appendChild(tr);
    });
  }
}

// --- Lógica del Reporte Consolidado (Resumen General) ---

function fetchAllHistoryFromGoogleSheets() {
  return fetch(getScriptUrlWithApiKey('get_history'))
    .then(res => res.json())
    .then(res => {
      if (res.status === "ok" && Array.isArray(res.data)) {
        return res.data;
      }
      throw new Error("Respuesta inválida o script antiguo");
    })
    .catch(err => {
      console.warn("Fallo en get_history global. Intentando carga paralela...", err);
      const dniList = Object.keys(employeesDatabase);
      const promises = dniList.map(dni => 
        fetch(`${getScriptUrlWithApiKey('get_history')}&dni=${encodeURIComponent(dni)}`)
          .then(res => res.json())
          .then(res => {
            if (res.status === "ok" && Array.isArray(res.data)) {
              return res.data.map(item => ({ ...item, dni: dni }));
            }
            return [];
          })
          .catch(() => [])
      );
      return Promise.all(promises).then(results => results.flat());
    });
}

function fetchAllHistoryLocal() {
  const history = [];
  Object.keys(employeesDatabase).forEach(dni => {
    const state = attendanceState[dni] || { history: [] };
    (state.history || []).forEach(item => {
      history.push({
        ...item,
        dni: dni
      });
    });
  });
  return Promise.resolve(history);
}

let consolidatedSortCol = 'name';
let consolidatedSortDir = 'asc';

function getSortIconHTML(colKey) {
  const isActive = (consolidatedSortCol === colKey);
  const iconName = isActive 
    ? (consolidatedSortDir === 'desc' ? 'arrow_downward' : 'arrow_upward') 
    : 'unfold_more';
  
  const bgStyle = isActive ? 'background: #3b82f6; color: #ffffff;' : 'background: rgba(255, 255, 255, 0.2); color: #cbd5e1;';
  const iconOpacity = isActive ? 'opacity: 1;' : 'opacity: 0.7;';

  return `<span class="sort-icon-badge" style="display: inline-flex; align-items: center; justify-content: center; width: 18px; height: 18px; border-radius: 50%; ${bgStyle} margin-left: 5px; vertical-align: middle; transition: all 0.2s ease;">
    <span class="material-symbols-rounded" style="font-size: 12px; ${iconOpacity}">${iconName}</span>
  </span>`;
}

function renderConsolidatedTable(history) {
  const thead = document.getElementById('admin-consolidated-thead');
  const tbody = document.getElementById('admin-consolidated-table-body');
  if (!thead || !tbody) return;

  if (!history || history.length === 0) {
    thead.innerHTML = `<tr><th>Colaborador</th><th>DNI</th><th class="text-center">Sin Datos</th></tr>`;
    tbody.innerHTML = '<tr><td colspan="3" class="text-center text-muted" style="padding: 25px;">No se registran marcas de asistencia en el historial.</td></tr>';
    return;
  }

  // 1. Normalizar marcas del historial y calcular timestamps a partir de la fecha y hora
  const normalizedHistory = history.map(item => {
    const normDate = normalizeDateStr(item.dateStr);
    const normTime = normalizeTimeStr(item.timeStr);
    const ts = getTimestampFromDateAndTime(normDate, normTime);
    return {
      ...item,
      dateStr: normDate,
      timeStr: normTime,
      timestamp: ts
    };
  }).filter(item => item.dni && employeesDatabase[item.dni]);

  // 2. Filtrar por rango de fechas
  const startDate = document.getElementById('consolidated-start-date')?.value || '';
  const endDate = document.getElementById('consolidated-end-date')?.value || '';
  
  const filteredHistory = normalizedHistory.filter(item => {
    return isDateInRange(item.dateStr, startDate, endDate);
  });

  if (filteredHistory.length === 0) {
    thead.innerHTML = `<tr><th>Colaborador</th><th>DNI</th><th class="text-center">Sin Datos</th></tr>`;
    tbody.innerHTML = '<tr><td colspan="3" class="text-center text-muted" style="padding: 25px;">No hay marcas registradas para el rango de fechas seleccionado.</td></tr>';
    return;
  }

  // 3. Extraer fechas únicas y ordenarlas cronológicamente
  const uniqueDates = new Set();
  filteredHistory.forEach(item => uniqueDates.add(item.dateStr));
  
  const sortedDates = Array.from(uniqueDates).sort((a, b) => {
    const partsA = a.split('/');
    const partsB = b.split('/');
    const dateA = new Date(partsA[2], partsA[1] - 1, partsA[0]);
    const dateB = new Date(partsB[2], partsB[1] - 1, partsB[0]);
    return dateA - dateB;
  });

  // 4. Agrupar marcas por colaborador DNI y fecha
  const dataMap = {};
  filteredHistory.forEach(item => {
    if (!dataMap[item.dni]) {
      dataMap[item.dni] = {};
    }
    if (!dataMap[item.dni][item.dateStr]) {
      dataMap[item.dni][item.dateStr] = [];
    }
    dataMap[item.dni][item.dateStr].push(item);
  });

  // 5. Dibujar cabecera dinámica con ordenamiento interactivo
  let headerHtml = `
    <tr>
      <th class="sortable-th" data-col="name" style="min-width: 200px; cursor: pointer; user-select: none;" title="Haz clic para ordenar por nombre de colaborador">
        <span>Colaborador</span>${getSortIconHTML('name')}
      </th>
      <th class="sortable-th" data-col="dni" style="min-width: 100px; cursor: pointer; user-select: none;" title="Haz clic para ordenar por DNI">
        <span>DNI</span>${getSortIconHTML('dni')}
      </th>
  `;
  sortedDates.forEach(dateStr => {
    headerHtml += `
      <th class="sortable-th text-center" data-col="date:${dateStr}" style="min-width: 110px; cursor: pointer; user-select: none;" title="Haz clic para ordenar por horas trabajadas en esta fecha">
        <span>${dateStr}</span>${getSortIconHTML('date:' + dateStr)}
      </th>`;
  });
  headerHtml += `
      <th class="sortable-th text-center cell-total-worked" data-col="totalWorked" style="min-width: 120px; cursor: pointer; user-select: none;" title="Haz clic para ordenar de Mayor a Menor por Total Horas">
        <span>Total Horas</span>${getSortIconHTML('totalWorked')}
      </th>
      <th class="sortable-th text-center cell-total-tardy" data-col="totalTardyCount" style="min-width: 100px; cursor: pointer; user-select: none;" title="Haz clic para ordenar por cantidad de tardanzas">
        <span>Tardanzas</span>${getSortIconHTML('totalTardyCount')}
      </th>
      <th class="sortable-th text-center cell-total-tardy-seconds" data-col="totalTardySecs" style="min-width: 125px; cursor: pointer; user-select: none;" title="Haz clic para ordenar por tiempo total de tardanzas">
        <span>Total Hrs. Tardanzas</span>${getSortIconHTML('totalTardySecs')}
      </th>
      <th class="sortable-th text-center cell-total-absent" data-col="totalAbsentCount" style="min-width: 100px; cursor: pointer; user-select: none;" title="Haz clic para ordenar por cantidad de faltas">
        <span>Faltas</span>${getSortIconHTML('totalAbsentCount')}
      </th>
    </tr>
  `;
  thead.innerHTML = headerHtml;

  // Escuchadores de evento en las cabeceras para cambiar ordenamiento
  thead.querySelectorAll('.sortable-th').forEach(th => {
    th.addEventListener('click', () => {
      const col = th.getAttribute('data-col');
      if (!col) return;
      if (consolidatedSortCol === col) {
        consolidatedSortDir = consolidatedSortDir === 'desc' ? 'asc' : 'desc';
      } else {
        consolidatedSortCol = col;
        // Si se hace clic en métricas (horas, tardanzas, faltas), ordenar por defecto de Mayor a Menor (desc)
        consolidatedSortDir = (col === 'name' || col === 'dni') ? 'asc' : 'desc';
      }
      renderConsolidatedTable(cachedConsolidatedHistory || history);
    });
  });

  // 6. Preparar y calcular datos por colaborador
  let refMonth = new Date().getMonth();
  let refYear = new Date().getFullYear();
  if (sortedDates.length > 0) {
    const p = sortedDates[0].split('/');
    if (p.length === 3) {
      refMonth = parseInt(p[1], 10) - 1;
      refYear = parseInt(p[2], 10);
    }
  }
  const dnis = Object.keys(employeesDatabase).filter(dni => isEmployeeVisibleInMonth(employeesDatabase[dni], refMonth, refYear));
  
  if (dnis.length === 0) {
    tbody.innerHTML = `<tr><td colspan="${5 + sortedDates.length}" class="text-center text-muted" style="padding: 25px;">No hay colaboradores en la base de datos.</td></tr>`;
    return;
  }

  const rowDataList = dnis.map(dni => {
    const employee = employeesDatabase[dni];
    let totalWorkedSeconds = 0;
    let totalTardinessCount = 0;
    let totalTardinessSeconds = 0;
    let totalAbsentCount = 0;
    const dateValuesMap = {};
    const dateCellsMap = {};

    sortedDates.forEach(dateStr => {
      const dayMarks = dataMap[dni] && dataMap[dni][dateStr] ? dataMap[dni][dateStr] : null;

      let isHoliday = false;
      const dateParts = dateStr.split('/');
      if (dateParts.length >= 2) {
        const dStr = String(parseInt(dateParts[0], 10)).padStart(2, '0');
        const mStr = String(parseInt(dateParts[1], 10)).padStart(2, '0');
        const dayMonth = `${dStr}/${mStr}`;
        isHoliday = GLOBAL_FERIADOS.includes(dayMonth);
        const customHoliday = feriadosDatabase.find(f => normalizeDateStr(f.dateStr) === normalizeDateStr(dateStr));
        if (customHoliday) isHoliday = true;
      }

      const justification = justificacionesDatabase.find(j => 
        String(j.dni) === String(dni) && 
        normalizeDateStr(j.dateStr) === normalizeDateStr(dateStr)
      );

      let daySched = null;
      let dayOfWeek = 1;
      if (dateParts.length === 3) {
        const day = parseInt(dateParts[0], 10);
        const month = parseInt(dateParts[1], 10) - 1;
        const year = parseInt(dateParts[2], 10);
        const dObj = new Date(year, month, day);
        if (!isNaN(dObj.getTime())) {
          dayOfWeek = dObj.getDay();
        }
      }

      const isFlexible = (employee.workStart === "—" || employee.weeklySchedule === "flexible");

      if (isFlexible) {
        daySched = { workStart: "—", workEnd: "—", expectedHours: 0, isRestDay: false, nobreak: true, isFlexible: true };
      } else if (employee.weeklySchedule) {
        let schedObj = employee.weeklySchedule;
        if (typeof schedObj === 'string' && schedObj.trim() !== '') {
          try { schedObj = JSON.parse(schedObj); } catch (e) { schedObj = null; }
        }
        if (schedObj && schedObj[dayOfWeek]) {
          daySched = schedObj[dayOfWeek];
        }
      }

      if (!daySched) {
        if (dayOfWeek === 0) daySched = { isRestDay: true, workStart: "---", workEnd: "---", expectedHours: 0 };
        else if (dayOfWeek === 6) daySched = { isRestDay: false, workStart: employee.workStart || "09:00", workEnd: "13:00", expectedHours: 4, nobreak: true };
        else daySched = { isRestDay: false, workStart: employee.workStart || "08:00", workEnd: employee.workEnd || "17:00", expectedHours: 8 };
      }

      const isRestDay = !!daySched.isRestDay;

      if (dayMarks && dayMarks.length > 0) {
        dayMarks.sort((a, b) => a.timestamp - b.timestamp);
        const report = calculateWorkedTimesForDate(dayMarks, employee, dateStr);
        
        const inMark = dayMarks.find(m => m.action === 'Ingreso');
        const outMark = dayMarks.find(m => m.action === 'Salida');
        const entTime = inMark ? inMark.timeStr : '---';
        const salTime = outMark ? outMark.timeStr : '---';
        
        totalWorkedSeconds += report.workedSeconds;
        dateValuesMap[dateStr] = report.workedSeconds;
        
        let tooltip = `Fecha: ${dateStr}\nEntrada: ${entTime} ${inMark && inMark.device ? '('+inMark.device+')' : ''}\nSalida: ${salTime} ${outMark && outMark.device ? '('+outMark.device+')' : ''}\nTrabajo Real: ${formatSecondsToHHMMSS(report.workedSeconds)}`;
        let cellText = formatSecondsToHHMMSS(report.workedSeconds);
        let cellClass = 'cell-assisted';
        
        if (report.tardiness) {
          totalTardinessCount++;
          totalTardinessSeconds += report.tardinessSeconds;
          const tardMins = Math.floor(report.tardinessSeconds / 60);
          tooltip += `\nTardanza: ${tardMins} min`;
          cellClass = 'cell-tardiness';
        }
        
        dateCellsMap[dateStr] = `<td class="${cellClass}" title="${tooltip}">${cellText}</td>`;
      } else {
        dateValuesMap[dateStr] = 0;
        let cellClass = 'cell-absent';
        let cellText = 'Falta';
        let tooltip = `Fecha: ${dateStr}`;
        
        const empStatusForDate = getEmployeeStatusForDate(employee, dateStr);

        if (empStatusForDate === 'BAJA') {
          cellClass = 'cell-baja';
          cellText = 'Baja';
          tooltip += `\nColaborador dado de baja (${employee.fechaBaja || ''})`;
        } else if (justification) {
          cellClass = 'cell-justified';
          cellText = `Justif: ${justification.type}`;
          tooltip += `\nJustificación: ${justification.type}\nDetalle: ${justification.details}`;
        } else if (isHoliday) {
          cellClass = 'cell-holiday';
          cellText = 'Feriado';
          tooltip += `\nFeriado`;
        } else if (isRestDay) {
          cellClass = 'cell-rest';
          cellText = 'Descanso';
          tooltip += `\nDía de Descanso`;
        } else {
          totalAbsentCount++;
          tooltip += `\nFalta / Inasistencia`;
        }
        
        dateCellsMap[dateStr] = `<td class="${cellClass}" title="${tooltip}">${cellText}</td>`;
      }
    });

    return {
      dni,
      name: employee.name,
      totalWorkedSeconds,
      totalTardinessCount,
      totalTardinessSeconds,
      totalAbsentCount,
      dateValuesMap,
      dateCellsMap
    };
  });

  // 7. Ordenar los datos según la columna y dirección activa
  rowDataList.sort((a, b) => {
    let valA, valB;
    if (consolidatedSortCol === 'name') {
      valA = a.name.toLowerCase();
      valB = b.name.toLowerCase();
    } else if (consolidatedSortCol === 'dni') {
      valA = a.dni;
      valB = b.dni;
    } else if (consolidatedSortCol === 'totalWorked') {
      valA = a.totalWorkedSeconds;
      valB = b.totalWorkedSeconds;
    } else if (consolidatedSortCol === 'totalTardyCount') {
      valA = a.totalTardinessCount;
      valB = b.totalTardinessCount;
    } else if (consolidatedSortCol === 'totalTardySecs') {
      valA = a.totalTardinessSeconds;
      valB = b.totalTardinessSeconds;
    } else if (consolidatedSortCol === 'totalAbsentCount') {
      valA = a.totalAbsentCount;
      valB = b.totalAbsentCount;
    } else if (consolidatedSortCol.startsWith('date:')) {
      const dStr = consolidatedSortCol.replace('date:', '');
      valA = a.dateValuesMap[dStr] || 0;
      valB = b.dateValuesMap[dStr] || 0;
    } else {
      valA = a.name.toLowerCase();
      valB = b.name.toLowerCase();
    }

    if (valA < valB) return consolidatedSortDir === 'asc' ? -1 : 1;
    if (valA > valB) return consolidatedSortDir === 'asc' ? 1 : -1;
    return 0;
  });

  // 8. Dibujar filas ordenadas en el cuerpo de la tabla
  tbody.innerHTML = '';
  rowDataList.forEach(row => {
    const tr = document.createElement('tr');
    let rowHtml = `
      <td class="table-employee-name" style="width: 220px; min-width: 220px; max-width: 220px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-weight: 500;">${row.name}</td>
      <td style="width: 100px; min-width: 100px; max-width: 100px;">${row.dni}</td>
    `;
    
    sortedDates.forEach(dateStr => {
      rowHtml += row.dateCellsMap[dateStr];
    });

    rowHtml += `
      <td class="cell-total-worked">${formatSecondsToHHMMSS(row.totalWorkedSeconds)}</td>
      <td class="cell-total-tardy">${row.totalTardinessCount} tard.</td>
      <td class="cell-total-tardy-seconds">${formatSecondsToHHMMSS(row.totalTardinessSeconds)}</td>
      <td class="cell-total-absent">${row.totalAbsentCount} faltas</td>
    `;
    
    tr.innerHTML = rowHtml;
    tbody.appendChild(tr);
  });
}

function loadConsolidatedReport() {
  const tbody = document.getElementById('admin-consolidated-table-body');
  if (!tbody) return;
  
  const printRange = document.getElementById('print-consolidated-range');
  if (printRange) {
    const startDate = document.getElementById('consolidated-start-date')?.value || 'Inicio';
    const endDate = document.getElementById('consolidated-end-date')?.value || 'Fin';
    printRange.textContent = `${startDate} al ${endDate}`;
  }

  cachedConsolidatedHistory = getAllCachedHistory();
  renderConsolidatedTable(cachedConsolidatedHistory);
}

// Lógica de pestañas del panel administrativo
function setupAdminTabs() {
  const tabButtons = document.querySelectorAll('.btn-admin-tab');
  const tabContents = document.querySelectorAll('.admin-tab-content');
  
  tabButtons.forEach(btn => {
    btn.addEventListener('click', () => {
      const targetTab = btn.getAttribute('data-tab');
      
      tabButtons.forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      
      tabContents.forEach(content => {
        if (content.id === `tab-${targetTab}-content`) {
          content.classList.add('active');
          content.classList.remove('hidden');
        } else {
          content.classList.remove('active');
          content.classList.add('hidden');
        }
      });
      
      if (targetTab === 'reports') {
        updateReportEmployeeSelect();
        const select = document.getElementById('select-report-employee');
        if (select && select.value) {
          renderAgentReport(select.value);
        }
      }
      
      if (targetTab === 'register') {
        updateReportEmployeeSelect();
        renderJustificacionesTable();
        renderFeriadosTable();
        syncJustificacionesFromGoogleSheets();
        syncFeriadosFromGoogleSheets();
      }
      
      if (targetTab === 'consolidated') {
        loadConsolidatedReport();
      }

      if (targetTab === 'daily') {
        const dateInput = document.getElementById('daily-select-date');
        if (dateInput && !dateInput.value) {
          const now = new Date();
          const dayStr = String(now.getDate()).padStart(2, '0');
          const monthStr = String(now.getMonth() + 1).padStart(2, '0');
          dateInput.value = `${now.getFullYear()}-${monthStr}-${dayStr}`;
        }
        loadDailySummaryReport();
      }

      // Reverted overtime tab setup
      
      if (targetTab === 'monthly') {
        const monthInput = document.getElementById('monthly-select-month');
        if (monthInput && !monthInput.value) {
          const now = new Date();
          const monthStr = String(now.getMonth() + 1).padStart(2, '0');
          monthInput.value = `${now.getFullYear()}-${monthStr}`;
        }
        loadMonthlyReport();
      }

      if (targetTab === 'gerencial') {
        loadGerencialReport();
      }
    });
  });

  // Delegación de clicks para desplegar/colapsar filas en el reporte por agente
  const reportTableBody = document.getElementById('admin-report-table-body');
  if (reportTableBody) {
    reportTableBody.addEventListener('click', (e) => {
      const summaryRow = e.target.closest('tr.summary-row');
      if (!summaryRow) return;

      const empDni = summaryRow.getAttribute('data-emp-dni');
      if (!empDni) return;

      const isExpanded = summaryRow.classList.contains('expanded-group');
      const detailRows = reportTableBody.querySelectorAll(`.history-row-emp-${empDni}`);
      const icon = summaryRow.querySelector('.toggle-icon');

      if (isExpanded) {
        summaryRow.classList.remove('expanded-group');
        if (icon) icon.style.transform = 'rotate(0deg)';
        detailRows.forEach(row => {
          row.style.display = 'none';
        });
      } else {
        summaryRow.classList.add('expanded-group');
        if (icon) icon.style.transform = 'rotate(90deg)';
        detailRows.forEach(row => {
          row.style.display = 'table-row';
        });
      }
    });
  }

  const select = document.getElementById('select-report-employee');
  if (select) {
    select.addEventListener('change', () => {
      if (select.value) {
        renderAgentReport(select.value);
      }
    });
  }

  const btnSyncAdmin = document.getElementById('btn-admin-sync');
  if (btnSyncAdmin) {
    btnSyncAdmin.addEventListener('click', () => {
      const originalHTML = btnSyncAdmin.innerHTML;
      btnSyncAdmin.disabled = true;
      btnSyncAdmin.innerHTML = `<span>Sincronizando...</span><span class="material-symbols-rounded animate-spin">sync</span>`;
      
      syncInitialData()
        .then(() => {
          showToast('success', 'Sincronización Completa', 'Se han descargado los últimos datos de la nube.');
          // Recargar pestaña activa
          const activeTabButton = document.querySelector('.btn-admin-tab.active');
          if (activeTabButton) {
            const tabName = activeTabButton.getAttribute('data-tab');
            if (tabName === 'live') {
              updateAdminView();
            } else if (tabName === 'reports') {
              const selectReportEmp = document.getElementById('select-report-employee');
              if (selectReportEmp && selectReportEmp.value) {
                renderAgentReport(selectReportEmp.value);
              }
            } else if (tabName === 'consolidated') {
              loadConsolidatedReport();
            } else if (tabName === 'daily') {
              loadDailySummaryReport();
            } else if (tabName === 'monthly') {
              loadMonthlyReport();
            }
          }
        })
        .catch(err => {
          console.error("Error en sincronización manual:", err);
          showToast('error', 'Error de Conexión', 'No se pudo completar la sincronización.');
        })
        .finally(() => {
          btnSyncAdmin.disabled = false;
          btnSyncAdmin.innerHTML = originalHTML;
        });
    });
  }

  const btnRefreshConsolidated = document.getElementById('btn-refresh-consolidated');
  if (btnRefreshConsolidated) {
    btnRefreshConsolidated.addEventListener('click', () => {
      syncInitialData().then(() => {
        loadConsolidatedReport();
      });
      showToast('info', 'Actualizando...', 'Sincronizando colaboradores y reporte consolidado.');
    });
  }

  // --- Lógica e interactividad de botones de exportación a PDF (Imprimir) ---
  const setupPDFExportListeners = () => {
    // 1. Reportes por Agente
    const btnExportAgentPDF = document.getElementById('btn-export-agent-pdf');
    if (btnExportAgentPDF) {
      btnExportAgentPDF.addEventListener('click', () => {
        const select = document.getElementById('select-report-employee');
        if (select && select.value && select.value !== 'all' && employeesDatabase[select.value]) {
          const emp = employeesDatabase[select.value];
          const empTitleName = document.getElementById('report-employee-name-display');
          if (empTitleName) empTitleName.textContent = `${emp.name} (DNI: ${select.value})`;
          const pName = document.getElementById('print-emp-name');
          const pDni = document.getElementById('print-emp-dni');
          const pRole = document.getElementById('print-emp-role');
          if (pName) pName.textContent = emp.name;
          if (pDni) pDni.textContent = select.value;
          if (pRole) pRole.textContent = emp.role || 'Colaborador';
          
          const start = document.getElementById('report-start-date')?.value || 'Inicio';
          const end = document.getElementById('report-end-date')?.value || 'Fin';
          const pRange = document.getElementById('print-report-range');
          if (pRange) pRange.textContent = `${start} al ${end}`;
        }
        window.print();
      });
    }

    // 2. Resumen Consolidado / General
    const btnExportConsolidatedPDF = document.getElementById('btn-export-consolidated-pdf');
    if (btnExportConsolidatedPDF) {
      btnExportConsolidatedPDF.addEventListener('click', () => {
        const printRange = document.getElementById('print-consolidated-range');
        if (printRange) {
          const start = document.getElementById('consolidated-start-date')?.value || 'Inicio';
          const end = document.getElementById('consolidated-end-date')?.value || 'Fin';
          printRange.textContent = `${start} al ${end}`;
        }
        window.print();
      });
    }

    // 3. Resumen Mensual
    const btnExportMonthlyPDF = document.getElementById('btn-export-monthly-pdf');
    if (btnExportMonthlyPDF) {
      btnExportMonthlyPDF.addEventListener('click', () => {
        const printMonth = document.getElementById('print-monthly-selected');
        const monthInput = document.getElementById('monthly-select-month');
        if (printMonth && monthInput) {
          printMonth.textContent = monthInput.value || 'Mes Actual';
        }
        window.print();
      });
    }

    // 4. Resumen Diario
    const btnExportDailyPDF = document.getElementById('btn-export-daily-pdf');
    if (btnExportDailyPDF) {
      btnExportDailyPDF.addEventListener('click', () => {
        const printDate = document.getElementById('print-daily-selected');
        const dateInput = document.getElementById('daily-select-date');
        if (printDate && dateInput) {
          printDate.textContent = dateInput.value || 'Hoy';
        }
        window.print();
      });
    }
  };

  setupPDFExportListeners();

  // --- Lógica e interactividad de filtros de fecha ---

  // Pestaña 2: Reporte por Agente
  const btnFilterReport = document.getElementById('btn-filter-report');
  if (btnFilterReport) {
    btnFilterReport.addEventListener('click', () => {
      if (select && select.value) {
        if (select.value === "all") {
          renderAgentReport("all");
          showToast('success', 'Filtro aplicado', 'Historial de todos los colaboradores filtrado.');
        } else {
          const employee = employeesDatabase[select.value];
          if (employee) {
            renderAgentReport(select.value);
            showToast('success', 'Filtro aplicado', 'Historial del agente filtrado.');
          }
        }
      } else {
        showToast('warning', 'Selecciona colaborador', 'Primero debes elegir un colaborador.');
      }
    });
  }

  const reportStartDate = document.getElementById('report-start-date');
  const reportEndDate = document.getElementById('report-end-date');
  const onReportDateChange = () => {
    if (select && select.value) {
      const employee = employeesDatabase[select.value];
      if (employee) renderReportTable(cachedAgentHistory, employee);
    }
  };
  if (reportStartDate) reportStartDate.addEventListener('change', onReportDateChange);
  if (reportEndDate) reportEndDate.addEventListener('change', onReportDateChange);

  // Pestaña 3: Resumen Consolidado
  const btnFilterConsolidated = document.getElementById('btn-filter-consolidated');
  if (btnFilterConsolidated) {
    btnFilterConsolidated.addEventListener('click', () => {
      renderConsolidatedTable(cachedConsolidatedHistory);
      showToast('success', 'Filtro aplicado', 'Resumen consolidado filtrado.');
    });
  }

  const consolidatedStartDate = document.getElementById('consolidated-start-date');
  const consolidatedEndDate = document.getElementById('consolidated-end-date');
  const onConsolidatedDateChange = () => {
    renderConsolidatedTable(cachedConsolidatedHistory);
  };
  if (consolidatedStartDate) consolidatedStartDate.addEventListener('change', onConsolidatedDateChange);
  if (consolidatedEndDate) consolidatedEndDate.addEventListener('change', onConsolidatedDateChange);

  // Filtros rápidos del consolidado
  const setupQuickFilterDateRange = (start, end) => {
    if (consolidatedStartDate) consolidatedStartDate.value = start;
    if (consolidatedEndDate) consolidatedEndDate.value = end;
    renderConsolidatedTable(cachedConsolidatedHistory);
    showToast('success', 'Rango aplicado', 'Se actualizó el rango de fecha seleccionado.');
  };

  const getFormattedDate = (date) => {
    const y = date.getFullYear();
    const m = String(date.getMonth() + 1).padStart(2, '0');
    const d = String(date.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
  };

  const btnQuickWeek = document.getElementById('btn-quick-week');
  if (btnQuickWeek) {
    btnQuickWeek.addEventListener('click', () => {
      const now = new Date();
      const currentDay = now.getDay();
      const monday = new Date(now);
      const distance = currentDay === 0 ? -6 : 1 - currentDay;
      monday.setDate(now.getDate() + distance);
      const sunday = new Date(monday);
      sunday.setDate(monday.getDate() + 6);
      setupQuickFilterDateRange(getFormattedDate(monday), getFormattedDate(sunday));
    });
  }

  const btnQuickLastWeek = document.getElementById('btn-quick-lastweek');
  if (btnQuickLastWeek) {
    btnQuickLastWeek.addEventListener('click', () => {
      const now = new Date();
      const currentDay = now.getDay();
      const lastMonday = new Date(now);
      const distance = currentDay === 0 ? -13 : -6 - currentDay;
      lastMonday.setDate(now.getDate() + distance);
      const lastSunday = new Date(lastMonday);
      lastSunday.setDate(lastMonday.getDate() + 6);
      setupQuickFilterDateRange(getFormattedDate(lastMonday), getFormattedDate(lastSunday));
    });
  }

  const btnQuickMonth = document.getElementById('btn-quick-month');
  if (btnQuickMonth) {
    btnQuickMonth.addEventListener('click', () => {
      const now = new Date();
      const firstDay = new Date(now.getFullYear(), now.getMonth(), 1);
      const lastDay = new Date(now.getFullYear(), now.getMonth() + 1, 0);
      setupQuickFilterDateRange(getFormattedDate(firstDay), getFormattedDate(lastDay));
    });
  }

  const btnQuick30Days = document.getElementById('btn-quick-30days');
  if (btnQuick30Days) {
    btnQuick30Days.addEventListener('click', () => {
      const now = new Date();
      const past = new Date(now);
      past.setDate(now.getDate() - 30);
      setupQuickFilterDateRange(getFormattedDate(past), getFormattedDate(now));
    });
  }
}

function updateEditModalScheduleVisibility(statusValue) {
  const isBaja = (statusValue === 'Baja');
  const typeContainer = document.getElementById('edit-schedule-type-container');
  const detailsContainer = document.getElementById('edit-schedule-details-container');
  const triggerContainer = document.getElementById('edit-weekly-trigger-container');
  const fieldsContainer = document.getElementById('edit-weekly-schedule-fields');
  const bajaDateContainer = document.getElementById('edit-baja-date-container');

  const elWStart = document.getElementById('edit-work-start');
  const elWEnd = document.getElementById('edit-work-end');
  const elBStart = document.getElementById('edit-break-start');
  const elBEnd = document.getElementById('edit-break-end');

  if (bajaDateContainer) {
    bajaDateContainer.style.display = isBaja ? 'block' : 'none';
  }

  if (typeContainer) {
    typeContainer.style.display = isBaja ? 'none' : 'block';
  }

  if (triggerContainer) {
    triggerContainer.style.display = isBaja ? 'none' : 'block';
  }

  if (isBaja) {
    if (detailsContainer) detailsContainer.style.display = 'none';
    if (fieldsContainer) fieldsContainer.classList.add('hidden');
    if (elWStart) elWStart.removeAttribute('required');
    if (elWEnd) elWEnd.removeAttribute('required');
    if (elBStart) elBStart.removeAttribute('required');
    if (elBEnd) elBEnd.removeAttribute('required');
  } else {
    const editScheduleType = document.getElementById('edit-schedule-type');
    const isFlexible = editScheduleType && editScheduleType.value === 'flexible';
    if (isFlexible) {
      if (detailsContainer) detailsContainer.style.display = 'none';
      if (elWStart) elWStart.removeAttribute('required');
      if (elWEnd) elWEnd.removeAttribute('required');
      if (elBStart) elBStart.removeAttribute('required');
      if (elBEnd) elBEnd.removeAttribute('required');
    } else {
      if (detailsContainer) detailsContainer.style.display = 'block';
      if (elWStart) elWStart.setAttribute('required', 'required');
      if (elWEnd) elWEnd.setAttribute('required', 'required');
      if (elBStart) elBStart.setAttribute('required', 'required');
      if (elBEnd) elBEnd.setAttribute('required', 'required');
    }
  }
}
window.updateEditModalScheduleVisibility = updateEditModalScheduleVisibility;

function openEditEmployeeModal(dni) {
  logDebug(`[EJECUTANDO] Editar Colaborador DNI: ${dni}`);
  const modal = document.getElementById('modal-edit-employee');
  const employee = findEmployeeByDni(dni);
  if (!modal || !employee) {
    logDebug(`[ERROR] Modal no existe (${!!modal}) o colaborador no existe (${!!employee})`, 'error');
    showToast('error', 'Error', 'No se pudo encontrar el colaborador para editar.');
    return;
  }
  logDebug(`[MODAL] Desplegando modal de edición para ${employee.name}`);
  const targetDni = String(employee.dni).replace(/'/g, '').trim();

  const elHidden = document.getElementById('edit-dni-hidden');
  const elDisplay = document.getElementById('edit-dni-display-input');
  const elName = document.getElementById('edit-name');
  const elRole = document.getElementById('edit-role');
  const elPin = document.getElementById('edit-pin');

  if (elHidden) elHidden.value = targetDni;
  if (elDisplay) elDisplay.value = targetDni;
  if (elName) elName.value = employee.name || '';
  if (elRole) elRole.value = employee.role || 'Colaborador';
  if (elPin) elPin.value = employee.pin || "1234";

  const elStatus = document.getElementById('edit-status');
  const elBajaDateContainer = document.getElementById('edit-baja-date-container');
  const elBajaDate = document.getElementById('edit-baja-date');
  if (elStatus) {
    const rawEstado = String(employee.estado || '').trim().toLowerCase();
    elStatus.value = rawEstado === 'baja' ? 'Baja' : 'Activo';
    if (elStatus.value === 'Baja') {
      if (elBajaDate) elBajaDate.value = employee.fechaBaja || '';
    } else {
      if (elBajaDate) elBajaDate.value = '';
    }
  }

  const isFlexible = (employee.workStart === "—" || employee.weeklySchedule === "flexible");
  const editScheduleType = document.getElementById('edit-schedule-type');
  const editScheduleContainer = document.getElementById('edit-schedule-details-container');
  if (editScheduleType) {
    editScheduleType.value = isFlexible ? 'flexible' : 'fixed';
  }

  if (typeof updateEditModalScheduleVisibility === 'function') {
    updateEditModalScheduleVisibility(elStatus ? elStatus.value : 'Activo');
  }

  const elWStart = document.getElementById('edit-work-start');
  const elWEnd = document.getElementById('edit-work-end');
  const elBStart = document.getElementById('edit-break-start');
  const elBEnd = document.getElementById('edit-break-end');

  if (!isFlexible) {
    if (elWStart) elWStart.value = employee.workStart || "08:00";
    if (elWEnd) elWEnd.value = employee.workEnd || "17:00";
    if (elBStart) elBStart.value = employee.breakStart || "13:00";
    if (elBEnd) elBEnd.value = employee.breakEnd || "14:00";
  }

  // Cargar weeklySchedule del colaborador
  let sched = employee.weeklySchedule;
  if (typeof sched === 'string' && sched !== 'flexible') {
    try { sched = JSON.parse(sched); } catch(e) { sched = null; }
  }
  if (sched === 'flexible') {
    sched = null;
  }
  if (!sched) {
    sched = {
      "1": { workStart: "09:00", workEnd: "18:00", expectedHours: 8, isRestDay: false },
      "2": { workStart: "09:00", workEnd: "18:00", expectedHours: 8, isRestDay: false },
      "3": { workStart: "09:00", workEnd: "18:00", expectedHours: 8, isRestDay: false },
      "4": { workStart: "09:00", workEnd: "18:00", expectedHours: 8, isRestDay: false },
      "5": { workStart: "09:00", workEnd: "18:00", expectedHours: 8, isRestDay: false },
      "6": { workStart: "09:00", workEnd: "13:00", expectedHours: 4, isRestDay: false },
      "0": { workStart: "08:00", workEnd: "17:00", expectedHours: 0, isRestDay: true }
    };
  }

  // Populate accordion inputs
  document.querySelectorAll('#edit-weekly-schedule-fields .day-schedule-row').forEach(row => {
    const dayKey = row.getAttribute('data-day');
    const daySched = sched[dayKey] || { workStart: "09:00", workEnd: "18:00", expectedHours: 8, isRestDay: false };
    
    const startInput = row.querySelector('.edit-day-start');
    const endInput = row.querySelector('.edit-day-end');
    const hoursInput = row.querySelector('.edit-day-hours');
    const restCheckbox = row.querySelector('.edit-day-rest');
    const nobreakCheckbox = row.querySelector('.edit-day-nobreak');

    if (startInput) startInput.value = daySched.workStart || "09:00";
    if (endInput) endInput.value = daySched.workEnd || "18:00";
    if (hoursInput) hoursInput.value = daySched.expectedHours !== undefined ? daySched.expectedHours : 8;
    if (restCheckbox) {
      restCheckbox.checked = !!daySched.isRestDay;
      restCheckbox.dispatchEvent(new Event('change'));
    }
    if (nobreakCheckbox) {
      nobreakCheckbox.checked = !!daySched.nobreak;
      nobreakCheckbox.disabled = !!daySched.isRestDay;
    }
  });

  modal.classList.remove('hidden');
  modal.style.display = 'flex';
  modal.style.zIndex = '10000';
}
window.openEditEmployeeModal = openEditEmployeeModal;

function setupEditModalListeners() {
  const modal = document.getElementById('modal-edit-employee');
  const cancelBtn = document.getElementById('btn-edit-cancel');
  const form = document.getElementById('form-edit-employee');

  if (!modal) return;

  if (cancelBtn) {
    cancelBtn.addEventListener('click', () => {
      modal.classList.add('hidden');
      modal.style.display = 'none';
    });
  }

  const elStatus = document.getElementById('edit-status');
  if (elStatus) {
    elStatus.addEventListener('change', (e) => {
      if (typeof updateEditModalScheduleVisibility === 'function') {
        updateEditModalScheduleVisibility(e.target.value);
      }
    });
  }

  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const rawDni = document.getElementById('edit-dni-hidden').value;
    const emp = findEmployeeByDni(rawDni);
    if (!emp) {
      logDebug(`[ERROR] Intento de guardar colaborador no existente: ${rawDni}`, 'error');
      showToast('error', 'Error', 'El colaborador no existe.');
      return;
    }
    const dni = emp.dni;
    const name = document.getElementById('edit-name').value.trim().toUpperCase();
    const role = document.getElementById('edit-role').value.trim();
    const pin = document.getElementById('edit-pin').value.trim();
    const workStart = document.getElementById('edit-work-start').value;
    const workEnd = document.getElementById('edit-work-end').value;
    const breakStart = document.getElementById('edit-break-start').value;
    const breakEnd = document.getElementById('edit-break-end').value;

    // Leer distribución semanal del acordeón de edición
    const weeklySchedule = {};
    document.querySelectorAll('#edit-weekly-schedule-fields .day-schedule-row').forEach(row => {
      const dayKey = row.getAttribute('data-day');
      const startInput = row.querySelector('.edit-day-start');
      const endInput = row.querySelector('.edit-day-end');
      const hoursInput = row.querySelector('.edit-day-hours');
      const restCheckbox = row.querySelector('.edit-day-rest');
      const nobreakCheckbox = row.querySelector('.edit-day-nobreak');

      const isRestDay = restCheckbox ? restCheckbox.checked : false;
      const nobreak = nobreakCheckbox ? nobreakCheckbox.checked : false;
      weeklySchedule[dayKey] = {
        workStart: startInput ? startInput.value : "09:00",
        workEnd: endInput ? endInput.value : "18:00",
        expectedHours: hoursInput ? parseFloat(hoursInput.value) || 0 : 8,
        isRestDay: isRestDay,
        nobreak: nobreak
      };
    });

    const isFlexibleVal = document.getElementById('edit-schedule-type').value === 'flexible';
    const finalWorkStart = isFlexibleVal ? "—" : workStart;
    const finalWorkEnd = isFlexibleVal ? "—" : workEnd;
    const finalBreakStart = isFlexibleVal ? "—" : breakStart;
    const finalBreakEnd = isFlexibleVal ? "—" : breakEnd;
    const finalWeeklySchedule = isFlexibleVal ? "flexible" : weeklySchedule;
    
    const finalStatus = document.getElementById('edit-status') ? document.getElementById('edit-status').value : 'Activo';
    const finalBajaDate = document.getElementById('edit-baja-date') ? document.getElementById('edit-baja-date').value : '';

    employeesDatabase[dni].name = name;
    employeesDatabase[dni].role = role;
    employeesDatabase[dni].pin = pin;
    employeesDatabase[dni].workStart = finalWorkStart;
    employeesDatabase[dni].workEnd = finalWorkEnd;
    employeesDatabase[dni].breakStart = finalBreakStart;
    employeesDatabase[dni].breakEnd = finalBreakEnd;
    employeesDatabase[dni].weeklySchedule = finalWeeklySchedule;
    employeesDatabase[dni].estado = finalStatus;
    if (finalStatus === 'Baja') {
      employeesDatabase[dni].fechaBaja = finalBajaDate;
    } else {
      delete employeesDatabase[dni].fechaBaja;
    }

    saveState();
    if (googleScriptUrl) {
      sendUpdateToGoogleSheets(dni, name, role, finalWorkStart, finalWorkEnd, finalBreakStart, finalBreakEnd, pin, finalWeeklySchedule, finalStatus, finalBajaDate);
    }
    modal.classList.add('hidden');
    modal.style.display = 'none';
    showToast('success', 'Colaborador Actualizado', `Los datos y horarios de ${name} fueron guardados.`);
    
    updateAdminView();
    
    const select = document.getElementById('select-report-employee');
    if (select && select.value === dni) {
      renderAgentReport(dni);
    }
  });
}

// --- LÓGICA DE EXPORTACIÓN DE REPORTES A CSV (EXCEL COMPATIBLE) ---

function exportAgentReportExcel() {
  const select = document.getElementById('select-report-employee');
  if (!select || !select.value) {
    showToast('warning', 'Selecciona colaborador', 'Primero debes elegir un colaborador para exportar.');
    return;
  }
  const dni = select.value;
  const isAll = (dni === "all");
  const employee = isAll ? "all" : employeesDatabase[dni];
  if (!employee) return;
  
  if (!cachedAgentHistory || cachedAgentHistory.length === 0) {
    showToast('warning', 'Sin datos', 'No hay datos históricos para exportar.');
    return;
  }
  
  // Normalizar y filtrar
  const normalizedHistory = cachedAgentHistory.map(item => {
    const normDate = normalizeDateStr(item.dateStr);
    const normTime = normalizeTimeStr(item.timeStr);
    return {
      ...item,
      dateStr: normDate,
      timeStr: normTime,
      timestamp: getTimestampFromDateAndTime(normDate, normTime)
    };
  });
  
  const startDate = document.getElementById('report-start-date')?.value || '';
  const endDate = document.getElementById('report-end-date')?.value || '';
  const filteredHistory = normalizedHistory.filter(item => isDateInRange(item.dateStr, startDate, endDate));
  
  if (filteredHistory.length === 0) {
    showToast('warning', 'Sin datos', 'No hay marcas en el rango de fechas seleccionado.');
    return;
  }

  const wb = XLSX.utils.book_new();
  const rows = [];

  if (isAll) {
    // EXPORTACIÓN MODO TODOS LOS COLABORADORES (DISEÑO AGRUPADO POR SECCIÓN)
    rows.push(["Reporte de Asistencia - Todos los Colaboradores"]);
    rows.push(["Rango de Fechas:", `${startDate || 'Inicio'} al ${endDate || 'Fin'}`]);
    rows.push([]);
    
    rows.push(["Fecha / Colaborador", "Entrada Real / Prog.", "Tardanza", "Refrigerio Real / Prog.", "Salida Real / Prog.", "Horas Extra", "Refrigerio Total", "Exceso de Break (min)", "Trabajo Real", "Diferencia"]);
    
    const historyByEmployee = {};
    filteredHistory.forEach(item => {
      if (!historyByEmployee[item.dni]) historyByEmployee[item.dni] = [];
      historyByEmployee[item.dni].push(item);
    });

    const sortedDnis = Object.keys(historyByEmployee).sort((a, b) => {
      const nameA = employeesDatabase[a]?.name || '';
      const nameB = employeesDatabase[b]?.name || '';
      return nameA.localeCompare(nameB);
    });

    sortedDnis.forEach(empDni => {
      const emp = employeesDatabase[empDni];
      if (!emp) return;

      const empHistory = historyByEmployee[empDni];

      const groupedByDate = {};
      empHistory.forEach(item => {
        if (!groupedByDate[item.dateStr]) groupedByDate[item.dateStr] = [];
        groupedByDate[item.dateStr].push(item);
      });

      const sortedDates = Object.keys(groupedByDate).sort((a, b) => {
        const partsA = a.split('/');
        const partsB = b.split('/');
        const dateA = new Date(partsA[2], partsA[1] - 1, partsA[0]);
        const dateB = new Date(partsB[2], partsB[1] - 1, partsB[0]);
        return dateB - dateA;
      });

      let totalWorkedSecs = 0;
      let totalTardySecs = 0;
      let totalOvertimeSecs = 0;
      let totalBreakSecs = 0;
      let totalDiffSecs = 0;

      const empDayRows = [];
      sortedDates.forEach(dateStr => {
        const dayMarks = groupedByDate[dateStr].sort((a, b) => a.timestamp - b.timestamp);
        const report = calculateWorkedTimesForDate(dayMarks, emp, dateStr);

        totalWorkedSecs += report.workedSeconds;
        totalTardySecs += report.tardinessSeconds;
        totalOvertimeSecs += report.horasAdicionalesSeconds;
        totalBreakSecs += report.breakSeconds;
        totalDiffSecs += report.diffSeconds;

        const breakStr = report.breakSeconds > 0 ? formatSecondsToHHMMSS(report.breakSeconds) : '00:00:00';
        const excessBreakMin = report.excessBreakMinutes > 0 ? report.excessBreakMinutes : 0;
        const workedStr = report.workedSeconds > 0 ? formatSecondsToHHMMSS(report.workedSeconds) : '00:00:00';
        const diffStr = report.status;
        const tardyStr = report.tardinessSeconds > 0 ? formatSecondsToHHMMSS(report.tardinessSeconds) : '00:00:00';
        const extraHrsStr = report.horasAdicionalesSeconds > 0 ? formatSecondsToHHMMSS(report.horasAdicionalesSeconds) : '00:00:00';
        
        const entradaText = report.entradaDevice && report.entradaDevice !== '---' ? `${report.entradaReal} (${report.entradaDevice})` : report.entradaReal;
        const salidaText = report.salidaDevice && report.salidaDevice !== '---' ? `${report.salidaReal} (${report.salidaDevice})` : report.salidaReal;

        empDayRows.push([
          dateStr,
          entradaText,
          tardyStr,
          report.breakReal,
          salidaText,
          extraHrsStr,
          breakStr,
          excessBreakMin,
          workedStr,
          diffStr
        ]);
      });

      // Añadir fila resumen del colaborador en Excel
      const scheduledBreakStr = `${emp.breakStart || "13:00"} - ${emp.breakEnd || "14:00"}`;
      rows.push([
        emp.name,
        emp.workStart || "08:00",
        totalTardySecs > 0 ? formatSecondsToHHMMSS(totalTardySecs) : '00:00:00',
        scheduledBreakStr,
        emp.workEnd || "18:00",
        totalOvertimeSecs > 0 ? formatSecondsToHHMMSS(totalOvertimeSecs) : '00:00:00',
        totalBreakSecs > 0 ? formatSecondsToHHMMSS(totalBreakSecs) : '00:00:00',
        "", // sin exceso acumulado en cabecera
        totalWorkedSecs > 0 ? formatSecondsToHHMMSS(totalWorkedSecs) : '00:00:00',
        (totalDiffSecs > 0 ? '+' : '') + formatSecondsToHHMMSS(totalDiffSecs)
      ]);

      // Añadir días
      empDayRows.forEach(dr => rows.push(dr));
      rows.push([]); // fila en blanco de separación
    });

    const ws = XLSX.utils.aoa_to_sheet(rows);
    const colWidths = rows[3].map((_, colIndex) => {
      const maxLen = Math.max(...rows.slice(3).map(row => row[colIndex] ? String(row[colIndex]).length : 0));
      return { wch: Math.max(12, maxLen + 3) };
    });
    ws['!cols'] = colWidths;
    
    XLSX.utils.book_append_sheet(wb, ws, "Reporte Todos");
    XLSX.writeFile(wb, `Reporte_Asistencia_Todos_${startDate || 'inicio'}_a_${endDate || 'fin'}.xlsx`);
    showToast('success', 'Exportación Completa', 'Se descargó el reporte de todos los colaboradores en formato Excel (.xlsx).');
    return;

  } else {
    // MODO INDIVIDUAL
    const grouped = {};
    filteredHistory.forEach(item => {
      if (!grouped[item.dateStr]) grouped[item.dateStr] = [];
      grouped[item.dateStr].push(item);
    });
    
    const sortedDates = Object.keys(grouped).sort((a, b) => {
      const partsA = a.split('/');
      const partsB = b.split('/');
      const dateA = new Date(partsA[2], partsA[1] - 1, partsA[0]);
      const dateB = new Date(partsB[2], partsB[1] - 1, partsB[0]);
      return dateB - dateA;
    });
    
    rows.push(["Reporte de Asistencia Personalizado"]);
    rows.push(["Colaborador:", employee.name]);
    rows.push(["DNI:", dni]);
    rows.push(["Cargo:", employee.role]);
    rows.push(["Jornada Planificada:", `${employee.workStart} a ${employee.workEnd}`]);
    rows.push(["Rango de Fechas:", `${startDate || 'Inicio'} al ${endDate || 'Fin'}`]);
    rows.push([]);
    
    rows.push(["Fecha", "Entrada Real", "Tardanza", "Refrigerio Real (Inicio -> Fin)", "Salida Real", "Horas Extra", "Refrigerio Total", "Exceso de Break (min)", "Trabajo Real", "Diferencia"]);
    
    sortedDates.forEach(dateStr => {
      const dayMarks = grouped[dateStr].sort((a, b) => a.timestamp - b.timestamp);
      const report = calculateWorkedTimesForDate(dayMarks, employee, dateStr);
      
      const breakStr = report.breakSeconds > 0 ? formatSecondsToHHMMSS(report.breakSeconds) : '00:00:00';
      const excessBreakMin = report.excessBreakMinutes > 0 ? report.excessBreakMinutes : 0;
      const workedStr = report.workedSeconds > 0 ? formatSecondsToHHMMSS(report.workedSeconds) : '00:00:00';
      const diffStr = report.status;
      const tardyStr = report.tardinessSeconds > 0 ? formatSecondsToHHMMSS(report.tardinessSeconds) : '00:00:00';
      const extraHrsStr = report.horasAdicionalesSeconds > 0 ? formatSecondsToHHMMSS(report.horasAdicionalesSeconds) : '00:00:00';
      
      const entradaText = report.entradaDevice && report.entradaDevice !== '---' ? `${report.entradaReal} (${report.entradaDevice})` : report.entradaReal;
      const salidaText = report.salidaDevice && report.salidaDevice !== '---' ? `${report.salidaReal} (${report.salidaDevice})` : report.salidaReal;
      
      rows.push([
        dateStr,
        entradaText,
        tardyStr,
        report.breakReal,
        salidaText,
        extraHrsStr,
        breakStr,
        excessBreakMin,
        workedStr,
        diffStr
      ]);
    });
    
    const ws = XLSX.utils.aoa_to_sheet(rows);
    const colWidths = rows[7].map((_, colIndex) => {
      const maxLen = Math.max(...rows.slice(7).map(row => row[colIndex] ? String(row[colIndex]).length : 0));
      return { wch: Math.max(12, maxLen + 3) };
    });
    ws['!cols'] = colWidths;
    
    XLSX.utils.book_append_sheet(wb, ws, "Reporte Colaborador");
    
    const cleanName = employee.name.replace(/[^a-zA-Z0-9]/g, "_");
    const dateRangeStr = `${startDate || 'inicio'}_a_${endDate || 'fin'}`;
    
    XLSX.writeFile(wb, `Reporte_Asistencia_${cleanName}_${dateRangeStr}.xlsx`);
    showToast('success', 'Exportación Completa', 'Se descargó el reporte del colaborador en formato Excel (.xlsx).');
  }
}

function exportConsolidatedExcel() {
  if (!cachedConsolidatedHistory || cachedConsolidatedHistory.length === 0) {
    showToast('warning', 'Sin datos', 'No hay datos consolidados para exportar.');
    return;
  }
  
  // Normalizar y filtrar
  const normalizedHistory = cachedConsolidatedHistory.map(item => {
    const normDate = normalizeDateStr(item.dateStr);
    const normTime = normalizeTimeStr(item.timeStr);
    return {
      ...item,
      dateStr: normDate,
      timeStr: normTime,
      timestamp: getTimestampFromDateAndTime(normDate, normTime)
    };
  }).filter(item => item.dni && employeesDatabase[item.dni]);
  
  const startDate = document.getElementById('consolidated-start-date')?.value || '';
  const endDate = document.getElementById('consolidated-end-date')?.value || '';
  const filteredHistory = normalizedHistory.filter(item => isDateInRange(item.dateStr, startDate, endDate));
  
  if (filteredHistory.length === 0) {
    showToast('warning', 'Sin datos', 'No hay marcas en el rango de fechas seleccionado.');
    return;
  }
  
  // Extraer fechas únicas y ordenarlas cronológicamente
  const uniqueDates = new Set();
  filteredHistory.forEach(item => uniqueDates.add(item.dateStr));
  const sortedDates = Array.from(uniqueDates).sort((a, b) => {
    const partsA = a.split('/');
    const partsB = b.split('/');
    const dateA = new Date(partsA[2], partsA[1] - 1, partsA[0]);
    const dateB = new Date(partsB[2], partsB[1] - 1, partsB[0]);
    return dateA - dateB;
  });
  
  // Agrupar
  const dataMap = {};
  filteredHistory.forEach(item => {
    if (!dataMap[item.dni]) dataMap[item.dni] = {};
    if (!dataMap[item.dni][item.dateStr]) dataMap[item.dni][item.dateStr] = [];
    dataMap[item.dni][item.dateStr].push(item);
  });
  
  const wb = XLSX.utils.book_new();
  const rows = [];
  
  rows.push(["Resumen Consolidado de Asistencia - Horas Trabajadas"]);
  rows.push(["Rango de Fechas:", `${startDate || 'Inicio'} al ${endDate || 'Fin'}`]);
  rows.push([]);
  
  // Cabecera
  const header = ["Colaborador", "DNI"];
  sortedDates.forEach(dateStr => header.push(dateStr));
  header.push("Total Horas", "Tardanzas", "Total Hrs. Tardanzas", "Faltas");
  rows.push(header);
  
  // Filas por cada colaborador
  let refMonth = new Date().getMonth();
  let refYear = new Date().getFullYear();
  if (sortedDates.length > 0) {
    const p = sortedDates[0].split('/');
    if (p.length === 3) {
      refMonth = parseInt(p[1], 10) - 1;
      refYear = parseInt(p[2], 10);
    }
  }

  Object.keys(employeesDatabase).forEach(dni => {
    const employee = employeesDatabase[dni];
    if (!isEmployeeVisibleInMonth(employee, refMonth, refYear)) return;
    const row = [employee.name, dni];
    
    let totalWorkedSeconds = 0;
    let totalTardinessCount = 0;
    let totalTardinessSeconds = 0;
    let totalAbsentCount = 0;
    
    sortedDates.forEach(dateStr => {
      const dayMarks = dataMap[dni] && dataMap[dni][dateStr] ? dataMap[dni][dateStr] : null;
      
      let isHoliday = false;
      const dateParts = dateStr.split('/');
      if (dateParts.length >= 2) {
        const dStr = String(parseInt(dateParts[0], 10)).padStart(2, '0');
        const mStr = String(parseInt(dateParts[1], 10)).padStart(2, '0');
        const dayMonth = `${dStr}/${mStr}`;
        const FERIADOS = [
          "01/01", "01/05", "29/06", "23/07", "28/07", "29/07", "06/08", "30/08", "08/10", "01/11", "08/12", "09/12", "25/12"
        ];
        isHoliday = GLOBAL_FERIADOS.includes(dayMonth);
        const customHoliday = feriadosDatabase.find(f => normalizeDateStr(f.dateStr) === normalizeDateStr(dateStr));
        if (customHoliday) isHoliday = true;
      }

      const justification = justificacionesDatabase.find(j => 
        String(j.dni) === String(dni) && 
        normalizeDateStr(j.dateStr) === normalizeDateStr(dateStr)
      );

      let daySched = null;
      let dayOfWeek = 1;
      if (dateParts.length === 3) {
        const day = parseInt(dateParts[0], 10);
        const month = parseInt(dateParts[1], 10) - 1;
        const year = parseInt(dateParts[2], 10);
        const dObj = new Date(year, month, day);
        if (!isNaN(dObj.getTime())) {
          dayOfWeek = dObj.getDay();
        }
      }

      const isFlexible = (employee.workStart === "—" || employee.weeklySchedule === "flexible");
      if (isFlexible) {
        daySched = { isRestDay: false, workStart: "—", workEnd: "—", expectedHours: 0, nobreak: true, isFlexible: true };
      } else if (employee.weeklySchedule) {
        let schedObj = employee.weeklySchedule;
        if (typeof schedObj === 'string' && schedObj.trim() !== '') {
          try { schedObj = JSON.parse(schedObj); } catch (e) { schedObj = null; }
        }
        if (schedObj && schedObj[dayOfWeek]) {
          daySched = schedObj[dayOfWeek];
        }
      }
      if (!daySched) {
        if (dayOfWeek === 0) daySched = { isRestDay: true };
        else daySched = { isRestDay: false };
      }

      const isRestDay = !!daySched.isRestDay;

      if (dayMarks && dayMarks.length > 0) {
        dayMarks.sort((a, b) => a.timestamp - b.timestamp);
        const report = calculateWorkedTimesForDate(dayMarks, employee, dateStr);
        const tardyMarker = report.tardiness ? " (T)" : "";
        const hasSalida = dayMarks.some(m => m.action === 'Salida');
        
        totalWorkedSeconds += report.workedSeconds;
        if (report.tardiness) {
          totalTardinessCount++;
          totalTardinessSeconds += report.tardinessSeconds;
        }

        if (hasSalida) {
          if (report.workedSeconds > 0) {
            row.push(`${formatSecondsToHHMMSS(report.workedSeconds)}${tardyMarker}`);
          } else {
            row.push(`00:00:00${tardyMarker}`);
          }
        } else {
          row.push(`--${tardyMarker}`);
        }
      } else {
        const empStatusForDate = getEmployeeStatusForDate(employee, dateStr);
        if (empStatusForDate === 'BAJA') {
          row.push("Baja");
        } else if (justification) {
          row.push(`Justificado: ${justification.type}`);
        } else if (isHoliday) {
          row.push("Feriado");
        } else if (isRestDay) {
          row.push("Descanso");
        } else {
          totalAbsentCount++;
          row.push("Falta");
        }
      }
    });
    row.push(
      formatSecondsToHHMMSS(totalWorkedSeconds), 
      `${totalTardinessCount} tard.`, 
      formatSecondsToHHMMSS(totalTardinessSeconds), 
      `${totalAbsentCount} faltas`
    );
    rows.push(row);
  });
  
  const ws = XLSX.utils.aoa_to_sheet(rows);
  
  // Auto-ajustar columnas
  const colWidths = header.map((_, colIndex) => {
    const maxLen = Math.max(...rows.slice(3).map(row => row[colIndex] ? String(row[colIndex]).length : 0));
    return { wch: Math.max(12, maxLen + 3) };
  });
  ws['!cols'] = colWidths;
  
  XLSX.utils.book_append_sheet(wb, ws, "Resumen Consolidado");
  const dateRangeStr = `${startDate || 'inicio'}_a_${endDate || 'fin'}`;
  XLSX.writeFile(wb, `Resumen_Consolidado_Asistencia_${dateRangeStr}.xlsx`);
  
  showToast('success', 'Exportación Completa', 'Se descargó el resumen consolidado en formato Excel (.xlsx).');
}

/* ==========================================================================
   FASE 2: PERSONALIZACIÓN DE HORARIOS SEMANALES Y REPORTE MENSUAL
   ========================================================================== */

function setupWeeklyScheduleUIListeners() {
  // Toggle para Tipo de Jornada en Registro
  const regScheduleType = document.getElementById('reg-schedule-type');
  const regScheduleContainer = document.getElementById('reg-schedule-details-container');
  if (regScheduleType && regScheduleContainer) {
    regScheduleType.addEventListener('change', () => {
      if (regScheduleType.value === 'flexible') {
        regScheduleContainer.classList.add('hidden');
        document.getElementById('reg-work-start').removeAttribute('required');
        document.getElementById('reg-work-end').removeAttribute('required');
        document.getElementById('reg-break-start').removeAttribute('required');
        document.getElementById('reg-break-end').removeAttribute('required');
      } else {
        regScheduleContainer.classList.remove('hidden');
        document.getElementById('reg-work-start').setAttribute('required', 'required');
        document.getElementById('reg-work-end').setAttribute('required', 'required');
        document.getElementById('reg-break-start').setAttribute('required', 'required');
        document.getElementById('reg-break-end').setAttribute('required', 'required');
      }
    });
  }

  // Toggle para Tipo de Jornada en Edición
  const editScheduleType = document.getElementById('edit-schedule-type');
  const editScheduleContainer = document.getElementById('edit-schedule-details-container');
  if (editScheduleType && editScheduleContainer) {
    editScheduleType.addEventListener('change', () => {
      const elStatus = document.getElementById('edit-status');
      const currentStatus = elStatus ? elStatus.value : 'Activo';
      updateEditModalScheduleVisibility(currentStatus);
    });
  }

  const btnToggleReg = document.getElementById('btn-toggle-reg-weekly-schedule');
  const regFields = document.getElementById('reg-weekly-schedule-fields');
  if (btnToggleReg && regFields) {
    btnToggleReg.addEventListener('click', () => {
      regFields.classList.toggle('hidden');
      const arrow = btnToggleReg.querySelector('.arrow-icon');
      if (arrow) {
        arrow.textContent = regFields.classList.contains('hidden') ? 'keyboard_arrow_down' : 'keyboard_arrow_up';
      }
    });
  }

  const btnToggleEdit = document.getElementById('btn-toggle-edit-weekly-schedule');
  const editFields = document.getElementById('edit-weekly-schedule-fields');
  if (btnToggleEdit && editFields) {
    btnToggleEdit.addEventListener('click', () => {
      editFields.classList.toggle('hidden');
      const arrow = btnToggleEdit.querySelector('.arrow-icon');
      if (arrow) {
        arrow.textContent = editFields.classList.contains('hidden') ? 'keyboard_arrow_down' : 'keyboard_arrow_up';
      }
    });
  }

  const setupRowCheckboxListeners = (checkboxClass, startClass, endClass, hoursClass) => {
    document.querySelectorAll(`.${checkboxClass}`).forEach(checkbox => {
      const row = checkbox.closest('.day-schedule-row');
      if (!row) return;
      const startInput = row.querySelector(`.${startClass}`);
      const endInput = row.querySelector(`.${endClass}`);
      const hoursInput = row.querySelector(`.${hoursClass}`);
      const nobreakInput = row.querySelector(`.${checkboxClass === 'reg-day-rest' ? 'reg-day-nobreak' : 'edit-day-nobreak'}`);

      const recalculateHours = () => {
        if (checkbox.checked) {
          if (hoursInput) hoursInput.value = '0';
          return;
        }
        if (startInput && endInput && hoursInput) {
          const startVal = startInput.value;
          const endVal = endInput.value;
          const isNoBreak = nobreakInput ? nobreakInput.checked : false;
          if (startVal && endVal) {
            const startMin = timeStrToMinutes(startVal);
            const endMin = timeStrToMinutes(endVal);
            let diffMin = endMin - startMin;
            if (diffMin < 0) {
              diffMin += 24 * 60; // cruce de medianoche
            }
            let totalHours = diffMin / 60;
            if (!isNoBreak) {
              totalHours = Math.max(0, totalHours - 1);
            }
            hoursInput.value = String(Math.round(totalHours * 100) / 100);
          }
        }
      };

      const updateInputsState = () => {
        const isChecked = checkbox.checked;
        if (startInput) {
          startInput.disabled = isChecked;
          startInput.style.opacity = isChecked ? '0.5' : '1';
        }
        if (endInput) {
          endInput.disabled = isChecked;
          endInput.style.opacity = isChecked ? '0.5' : '1';
        }
        if (nobreakInput) {
          nobreakInput.disabled = isChecked;
          nobreakInput.style.opacity = isChecked ? '0.5' : '1';
          if (isChecked) {
            nobreakInput.checked = false;
          }
        }
        if (hoursInput) {
          hoursInput.disabled = isChecked;
          hoursInput.style.opacity = isChecked ? '0.5' : '1';
          if (isChecked) {
            hoursInput.value = '0';
          } else {
            recalculateHours();
          }
        }
      };

      updateInputsState();
      checkbox.addEventListener('change', updateInputsState);

      if (startInput) startInput.addEventListener('input', recalculateHours);
      if (endInput) endInput.addEventListener('input', recalculateHours);
      if (nobreakInput) nobreakInput.addEventListener('change', recalculateHours);
    });
  };

  setupRowCheckboxListeners('reg-day-rest', 'reg-day-start', 'reg-day-end', 'reg-day-hours');
  setupRowCheckboxListeners('edit-day-rest', 'edit-day-start', 'edit-day-end', 'edit-day-hours');
}

function setupMonthlyReportUIListeners() {
  const btnFilter = document.getElementById('btn-filter-monthly');
  if (btnFilter) {
    btnFilter.addEventListener('click', loadMonthlyReport);
  }

  const btnExportExcel = document.getElementById('btn-export-monthly-excel');
  if (btnExportExcel) {
    btnExportExcel.addEventListener('click', exportMonthlyExcel);
  }
}

function setupDailySummaryListeners() {
  const btnFilter = document.getElementById('btn-filter-daily');
  if (btnFilter) {
    btnFilter.addEventListener('click', loadDailySummaryReport);
  }

  const btnExportExcel = document.getElementById('btn-export-daily-excel');
  if (btnExportExcel) {
    btnExportExcel.addEventListener('click', exportDailySummaryExcel);
  }

  const btnExportPDF = document.getElementById('btn-export-daily-pdf');
  if (btnExportPDF) {
    btnExportPDF.addEventListener('click', () => window.print());
  }
}

function loadDailySummaryReport() {
  const tbody = document.getElementById('admin-daily-table-body');
  if (!tbody) return;

  const dateInput = document.getElementById('daily-select-date');
  if (!dateInput || !dateInput.value) {
    const now = new Date();
    const dayStr = String(now.getDate()).padStart(2, '0');
    const monthStr = String(now.getMonth() + 1).padStart(2, '0');
    dateInput.value = `${now.getFullYear()}-${monthStr}-${dayStr}`;
  }

  const history = getAllCachedHistory();
  renderDailySummaryTable(history);
}

function renderDailySummaryTable(history) {
  const tbody = document.getElementById('admin-daily-table-body');
  if (!tbody) return;

  const dateInput = document.getElementById('daily-select-date');
  if (!dateInput || !dateInput.value) {
    tbody.innerHTML = '<tr><td colspan="8" class="text-center text-muted" style="padding: 25px;">Por favor selecciona una fecha válida.</td></tr>';
    return;
  }

  const [yearStr, monthStr, dayStr] = dateInput.value.split('-');
  const selectedDateStr = `${dayStr}/${monthStr}/${yearStr}`;
  const normSelectedDate = normalizeDateStr(selectedDateStr);

  const printDate = document.getElementById('print-daily-selected');
  if (printDate) {
    printDate.textContent = selectedDateStr;
  }

  const staffIds = Object.keys(employeesDatabase)
    .filter(dni => isEmployeeVisibleInMonth(employeesDatabase[dni], parseInt(monthStr, 10) - 1, parseInt(yearStr, 10)))
    .sort((a, b) => employeesDatabase[a].name.localeCompare(employeesDatabase[b].name));

  if (staffIds.length === 0) {
    tbody.innerHTML = '<tr><td colspan="8" class="text-center text-muted" style="padding: 25px;">No hay colaboradores registrados.</td></tr>';
    return;
  }

  const normalizedHistory = history.map(item => {
    const normDate = normalizeDateStr(item.dateStr);
    const normTime = normalizeTimeStr(item.timeStr);
    const ts = getTimestampFromDateAndTime(normDate, normTime);
    return {
      ...item,
      dateStr: normDate,
      timeStr: normTime,
      timestamp: ts
    };
  }).filter(item => item.dateStr === normSelectedDate);

  let html = '';

  staffIds.forEach(dni => {
    const employee = employeesDatabase[dni];
    const dayMarks = normalizedHistory.filter(item => String(item.dni) === String(dni));

    let isHoliday = false;
    const parts = selectedDateStr.split('/');
    if (parts.length >= 2) {
      const dStr = String(parseInt(parts[0], 10)).padStart(2, '0');
      const mStr = String(parseInt(parts[1], 10)).padStart(2, '0');
      const dayMonth = `${dStr}/${mStr}`;
      const FERIADOS = [
        "01/01", "01/05", "29/06", "23/07", "28/07", "29/07", "06/08", "30/08", "08/10", "01/11", "08/12", "09/12", "25/12"
      ];
      isHoliday = GLOBAL_FERIADOS.includes(dayMonth);
      const customHoliday = feriadosDatabase.find(f => normalizeDateStr(f.dateStr) === normSelectedDate);
      if (customHoliday) isHoliday = true;
    }

    const justification = justificacionesDatabase.find(j => 
      String(j.dni) === String(dni) && 
      normalizeDateStr(j.dateStr) === normSelectedDate
    );

    let daySched = null;
    let dayOfWeek = 1;
    const d = new Date(parseInt(yearStr, 10), parseInt(monthStr, 10) - 1, parseInt(dayStr, 10));
    if (!isNaN(d.getTime())) {
      dayOfWeek = d.getDay();
    }

    const isFlexible = (employee.workStart === "—" || employee.weeklySchedule === "flexible");

    if (isFlexible) {
      daySched = { workStart: "—", workEnd: "—", expectedHours: 0, isRestDay: false, nobreak: true, isFlexible: true };
    } else if (employee.weeklySchedule) {
      let schedObj = employee.weeklySchedule;
      if (typeof schedObj === 'string' && schedObj.trim() !== '') {
        try { schedObj = JSON.parse(schedObj); } catch (e) { schedObj = null; }
      }
      if (schedObj && schedObj[dayOfWeek]) {
        daySched = schedObj[dayOfWeek];
      }
    }

    if (!daySched) {
      if (dayOfWeek === 0) daySched = { isRestDay: true, workStart: "---", workEnd: "---", expectedHours: 0 };
      else if (dayOfWeek === 6) daySched = { isRestDay: false, workStart: employee.workStart || "09:00", workEnd: "13:00", expectedHours: 4, nobreak: true };
      else daySched = { isRestDay: false, workStart: employee.workStart || "08:00", workEnd: employee.workEnd || "17:00", expectedHours: 8 };
    }

    const isRestDay = !!daySched.isRestDay;

    let rowClass = '';
    let statusBadge = '';
    let entradaDisplay = '---';
    let salidaDisplay = '---';
    let breakDisplay = '00:00:00';
    let workedDisplay = '00:00:00';
    let tardinessDisplay = '---';

    if (dayMarks.length > 0) {
      const report = calculateWorkedTimesForDate(dayMarks, employee, selectedDateStr);
      
      const inMark = dayMarks.find(m => m.action === 'Ingreso');
      const outMark = dayMarks.find(m => m.action === 'Salida');
      
      entradaDisplay = inMark ? `${inMark.timeStr} ${getDeviceIconShortHTML(inMark.device)}` : '---';
      salidaDisplay = outMark ? `${outMark.timeStr} ${getDeviceIconShortHTML(outMark.device)}` : '---';
      breakDisplay = formatSecondsToHHMMSS(report.breakSeconds);
      workedDisplay = formatSecondsToHHMMSS(report.workedSeconds);

      if (report.tardiness) {
        const mins = Math.floor(report.tardinessSeconds / 60);
        tardinessDisplay = `<span style="color: var(--color-error); font-weight: 600;">${mins} min</span>`;
        statusBadge = `<span class="table-status-badge Salida">Tardanza</span>`;
        rowClass = 'row-tardiness';
      } else {
        tardinessDisplay = isFlexible ? '---' : '0 min';
        statusBadge = `<span class="table-status-badge Ingreso">Asistió</span>`;
      }
      if (justification && justification.type === 'Permiso por Horas') {
        const compStr = justification.compensation === 'Sin goce' ? 'Sin goce' : 'Con goce';
        statusBadge = `<span class="table-status-badge Inicio-Refrigerio" style="background: rgba(30, 144, 255, 0.1); color: #1e90ff; border-color: rgba(30, 144, 255, 0.3);" title="Permiso de ${justification.startTime} a ${justification.endTime} (${compStr}) - ${justification.details}">Asistió (Permiso)</span>`;
        rowClass = 'row-justified';
      }
      if (isFlexible) {
        statusBadge = `<span class="table-status-badge Fin-Refrigerio">Asistió (Flexible)</span>`;
      }

    } else {
      const empStatusForDate = getEmployeeStatusForDate(employee, selectedDateStr);
      if (empStatusForDate === 'BAJA') {
        statusBadge = `<span class="table-status-badge Desconectado" style="background: rgba(148, 163, 184, 0.2); color: #64748b; border: 1px solid #cbd5e1;">Baja</span>`;
        rowClass = 'row-baja';
      } else if (justification) {
        statusBadge = `<span class="table-status-badge Inicio-Refrigerio" title="${justification.details}">Justificado: ${justification.type}</span>`;
        rowClass = 'row-justified';
      } else if (isHoliday) {
        statusBadge = `<span class="table-status-badge Fin-Refrigerio">Feriado</span>`;
        rowClass = 'row-holiday';
      } else if (isRestDay) {
        statusBadge = `<span class="table-status-badge" style="background: var(--surface-1); color: var(--text-secondary);">Descanso</span>`;
        rowClass = 'row-rest';
      } else {
        statusBadge = `<span class="table-status-badge Salida">Falta</span>`;
        rowClass = 'row-absent';
      }
    }

    html += `
      <tr class="${rowClass}">
        <td class="table-employee-name">${employee.name}</td>
        <td>${dni}</td>
        <td class="text-center">${entradaDisplay}</td>
        <td class="text-center">${salidaDisplay}</td>
        <td class="text-center">${breakDisplay}</td>
        <td class="text-center" style="font-weight: 600;">${workedDisplay}</td>
        <td class="text-center">${tardinessDisplay}</td>
        <td class="text-center">${statusBadge}</td>
      </tr>
    `;
  });

  tbody.innerHTML = html;
}

function exportDailySummaryExcel() {
  const dateInput = document.getElementById('daily-select-date');
  if (!dateInput || !dateInput.value) {
    showToast('error', 'Error', 'Selecciona una fecha válida antes de exportar.');
    return;
  }
  const [yearStr, monthStr, dayStr] = dateInput.value.split('-');
  const selectedDateStr = `${dayStr}/${monthStr}/${yearStr}`;

  const wb = XLSX.utils.book_new();
  const rows = [];

  rows.push(["ASISTENCIAPRO - REPORTE DIARIO DE ASISTENCIA"]);
  rows.push([`Fecha del Reporte: ${selectedDateStr}`]);
  rows.push([]);

  const header = [
    "Colaborador",
    "DNI",
    "Hora Entrada",
    "Dispositivo Entrada",
    "Hora Salida",
    "Dispositivo Salida",
    "Refrigerio Usado",
    "Trabajo Real (HH:MM:SS)",
    "Minutos de Tardanza",
    "Estado / Incidencia"
  ];
  rows.push(header);

  const history = getAllCachedHistory();
  const normSelectedDate = normalizeDateStr(selectedDateStr);

  const normalizedHistory = history.map(item => {
    return {
      ...item,
      dateStr: normalizeDateStr(item.dateStr),
      timeStr: normalizeTimeStr(item.timeStr)
    };
  }).filter(item => item.dateStr === normSelectedDate);

  const staffIds = Object.keys(employeesDatabase).sort((a, b) => 
    employeesDatabase[a].name.localeCompare(employeesDatabase[b].name)
  );

  staffIds.forEach(dni => {
    const employee = employeesDatabase[dni];
    const dayMarks = normalizedHistory.filter(item => String(item.dni) === String(dni));

    let isHoliday = false;
    const parts = selectedDateStr.split('/');
    if (parts.length >= 2) {
      const dStr = String(parseInt(parts[0], 10)).padStart(2, '0');
      const mStr = String(parseInt(parts[1], 10)).padStart(2, '0');
      const dayMonth = `${dStr}/${mStr}`;
      const FERIADOS = [
        "01/01", "01/05", "29/06", "23/07", "28/07", "29/07", "06/08", "30/08", "08/10", "01/11", "08/12", "09/12", "25/12"
      ];
      isHoliday = GLOBAL_FERIADOS.includes(dayMonth);
      const customHoliday = feriadosDatabase.find(f => normalizeDateStr(f.dateStr) === normSelectedDate);
      if (customHoliday) isHoliday = true;
    }

    const justification = justificacionesDatabase.find(j => 
      String(j.dni) === String(dni) && 
      normalizeDateStr(j.dateStr) === normSelectedDate
    );

    let daySched = null;
    let dayOfWeek = 1;
    const d = new Date(parseInt(yearStr, 10), parseInt(monthStr, 10) - 1, parseInt(dayStr, 10));
    if (!isNaN(d.getTime())) {
      dayOfWeek = d.getDay();
    }
    const isFlexible = (employee.workStart === "—" || employee.weeklySchedule === "flexible");
    
    if (isFlexible) {
      daySched = { isRestDay: false, workStart: "—", workEnd: "—", expectedHours: 0, nobreak: true, isFlexible: true };
    } else if (employee.weeklySchedule) {
      let schedObj = employee.weeklySchedule;
      if (typeof schedObj === 'string' && schedObj.trim() !== '') {
        try { schedObj = JSON.parse(schedObj); } catch (e) { schedObj = null; }
      }
      if (schedObj && schedObj[dayOfWeek]) {
        daySched = schedObj[dayOfWeek];
      }
    }

    if (!daySched) {
      if (dayOfWeek === 0) daySched = { isRestDay: true };
      else daySched = { isRestDay: false };
    }

    const isRestDay = !!daySched.isRestDay;

    let entradaTime = '---';
    let entradaDevice = '---';
    let salidaTime = '---';
    let salidaDevice = '---';
    let breakTime = '00:00:00';
    let workedTime = '00:00:00';
    let tardinessMins = '---';
    let statusText = '---';

    if (dayMarks.length > 0) {
      const report = calculateWorkedTimesForDate(dayMarks, employee, selectedDateStr);
      const inMark = dayMarks.find(m => m.action === 'Ingreso');
      const outMark = dayMarks.find(m => m.action === 'Salida');

      entradaTime = inMark ? inMark.timeStr : '---';
      entradaDevice = inMark ? (inMark.device || 'Desconocido') : '---';
      salidaTime = outMark ? outMark.timeStr : '---';
      salidaDevice = outMark ? (outMark.device || 'Desconocido') : '---';

      breakTime = formatSecondsToHHMMSS(report.breakSeconds);
      workedTime = formatSecondsToHHMMSS(report.workedSeconds);

      if (report.tardiness) {
        tardinessMins = `${Math.floor(report.tardinessSeconds / 60)} min`;
        statusText = "Tardanza";
      } else {
        tardinessMins = isFlexible ? "---" : "0 min";
        statusText = isFlexible ? "Asistió (Flexible)" : "Asistió Normal";
      }
    } else {
      if (justification) {
        statusText = `Justificado: ${justification.type}`;
      } else if (isHoliday) {
        statusText = "Feriado";
      } else if (isRestDay) {
        statusText = "Descanso";
      } else {
        statusText = "Falta";
      }
    }

    rows.push([
      employee.name,
      dni,
      entradaTime,
      entradaDevice,
      salidaTime,
      salidaDevice,
      breakTime,
      workedTime,
      tardinessMins,
      statusText
    ]);
  });

  const ws = XLSX.utils.aoa_to_sheet(rows);
  
  const colWidths = header.map((_, colIndex) => {
    const maxLen = Math.max(...rows.slice(3).map(row => row[colIndex] ? String(row[colIndex]).length : 0));
    return { wch: Math.max(12, maxLen + 3) };
  });
  ws['!cols'] = colWidths;

  XLSX.utils.book_append_sheet(wb, ws, "Resumen Diario");
  XLSX.writeFile(wb, `Resumen_Diario_Asistencia_${dateInput.value}.xlsx`);
  
  showToast('success', 'Exportación Completa', 'Se descargó el resumen diario en formato Excel (.xlsx).');
}

function loadMonthlyReport() {
  const tbody = document.getElementById('admin-monthly-table-body');
  if (!tbody) return;
  
  const monthInput = document.getElementById('monthly-select-month');
  if (monthInput && !monthInput.value) {
    const now = new Date();
    const monthStr = String(now.getMonth() + 1).padStart(2, '0');
    monthInput.value = `${now.getFullYear()}-${monthStr}`;
  }

  if (!monthInput || !monthInput.value) {
    tbody.innerHTML = '<tr><td colspan="11" class="text-center text-muted" style="padding: 25px;">Por favor selecciona un mes válido.</td></tr>';
    return;
  }

  const printMonth = document.getElementById('print-monthly-selected');
  if (printMonth) {
    printMonth.textContent = monthInput.value;
  }
  
  const history = getAllCachedHistory();
  renderMonthlyTable(history);
}


let monthlySortCol = 'name';
let monthlySortDir = 'asc';

function getMonthlySortIconHTML(colKey) {
  const isActive = (monthlySortCol === colKey);
  const iconName = isActive 
    ? (monthlySortDir === 'desc' ? 'arrow_downward' : 'arrow_upward') 
    : 'unfold_more';
  
  const bgStyle = isActive ? 'background: #3b82f6; color: #ffffff;' : 'background: rgba(255, 255, 255, 0.2); color: #cbd5e1;';
  const iconOpacity = isActive ? 'opacity: 1;' : 'opacity: 0.7;';

  return `<span class="sort-icon-badge" style="display: inline-flex; align-items: center; justify-content: center; width: 18px; height: 18px; border-radius: 50%; ${bgStyle} margin-left: 5px; vertical-align: middle; transition: all 0.2s ease;">
    <span class="material-symbols-rounded" style="font-size: 12px; ${iconOpacity}">${iconName}</span>
  </span>`;
}

function renderMonthlyTable(history) {
  const tbody = document.getElementById('admin-monthly-table-body');
  const thead = document.getElementById('admin-monthly-thead');
  if (!tbody) return;

  const monthInput = document.getElementById('monthly-select-month');
  if (!monthInput || !monthInput.value) {
    tbody.innerHTML = '<tr><td colspan="11" class="text-center text-muted" style="padding: 25px;">Por favor selecciona un mes válido.</td></tr>';
    return;
  }

  const selectedMonth = monthInput.value;
  const [yearStr, monthStr] = selectedMonth.split('-');
  const year = parseInt(yearStr, 10);
  const monthIndex = parseInt(monthStr, 10) - 1;

  if (thead) {
    thead.innerHTML = `
      <tr>
        <th class="sortable-th" data-col="name" style="min-width: 200px; cursor: pointer; user-select: none;" title="Haz clic para ordenar por nombre de colaborador">
          <span>Colaborador</span>${getMonthlySortIconHTML('name')}
        </th>
        <th class="sortable-th" data-col="dni" style="min-width: 100px; cursor: pointer; user-select: none;" title="Haz clic para ordenar por DNI">
          <span>DNI</span>${getMonthlySortIconHTML('dni')}
        </th>
        <th class="sortable-th text-center" data-col="diasLaborables" style="min-width: 110px; cursor: pointer; user-select: none;">
          <span>Días Laborables</span>${getMonthlySortIconHTML('diasLaborables')}
        </th>
        <th class="sortable-th text-center" data-col="diasAsistidos" style="min-width: 110px; cursor: pointer; user-select: none;">
          <span>Días Asistidos</span>${getMonthlySortIconHTML('diasAsistidos')}
        </th>
        <th class="sortable-th text-center" data-col="faltas" style="min-width: 120px; cursor: pointer; user-select: none;" title="Haz clic para ordenar de Mayor a Menor por faltas">
          <span>Faltas (Inasistencias)</span>${getMonthlySortIconHTML('faltas')}
        </th>
        <th class="sortable-th text-center" data-col="diasJustificados" style="min-width: 120px; cursor: pointer; user-select: none;">
          <span>Días Justificados</span>${getMonthlySortIconHTML('diasJustificados')}
        </th>
        <th class="sortable-th text-center" data-col="tardanzasCount" style="min-width: 110px; cursor: pointer; user-select: none;" title="Haz clic para ordenar de Mayor a Menor por tardanzas">
          <span>Tardanzas (Cant.)</span>${getMonthlySortIconHTML('tardanzasCount')}
        </th>
        <th class="sortable-th text-center" data-col="tardanzasSeconds" style="min-width: 125px; cursor: pointer; user-select: none;" title="Haz clic para ordenar por tiempo total de tardanzas">
          <span>Tardanzas (Acum.)</span>${getMonthlySortIconHTML('tardanzasSeconds')}
        </th>
        <th class="sortable-th text-center" data-col="excessBreakSeconds" style="min-width: 130px; cursor: pointer; user-select: none;">
          <span>Exceso Break (Acum.)</span>${getMonthlySortIconHTML('excessBreakSeconds')}
        </th>
        <th class="sortable-th text-center cell-total-worked" data-col="totalWorkedSeconds" style="min-width: 130px; cursor: pointer; user-select: none;" title="Haz clic para ordenar de Mayor a Menor por total trabajado">
          <span>Trabajo Real (Total)</span>${getMonthlySortIconHTML('totalWorkedSeconds')}
        </th>
        <th class="sortable-th text-center" data-col="horasAdicionalesSeconds" style="min-width: 110px; cursor: pointer; user-select: none;">
          <span>Horas Extra</span>${getMonthlySortIconHTML('horasAdicionalesSeconds')}
        </th>
      </tr>
    `;

    thead.querySelectorAll('.sortable-th').forEach(th => {
      th.addEventListener('click', () => {
        const col = th.getAttribute('data-col');
        if (!col) return;
        if (monthlySortCol === col) {
          monthlySortDir = monthlySortDir === 'desc' ? 'asc' : 'desc';
        } else {
          monthlySortCol = col;
          monthlySortDir = (col === 'name' || col === 'dni') ? 'asc' : 'desc';
        }
        renderMonthlyTable(history);
      });
    });
  }

  const normalizedHistory = history.map(item => {
    const normDate = normalizeDateStr(item.dateStr);
    const normTime = normalizeTimeStr(item.timeStr);
    const ts = getTimestampFromDateAndTime(normDate, normTime);
    return {
      ...item,
      dateStr: normDate,
      timeStr: normTime,
      timestamp: ts
    };
  }).filter(item => {
    if (!item.dni || !employeesDatabase[item.dni] || !item.dateStr) return false;
    const parts = item.dateStr.split('/');
    if (parts.length !== 3) return false;
    const itemYear = parseInt(parts[2], 10);
    const itemMonth = parseInt(parts[1], 10);
    return itemYear === year && itemMonth === (monthIndex + 1);
  });

  const dataMap = {};
  normalizedHistory.forEach(item => {
    if (!dataMap[item.dni]) {
      dataMap[item.dni] = {};
    }
    if (!dataMap[item.dni][item.dateStr]) {
      dataMap[item.dni][item.dateStr] = [];
    }
    dataMap[item.dni][item.dateStr].push(item);
  });

  const now = new Date();
  const totalDaysInMonth = new Date(year, monthIndex + 1, 0).getDate();

  tbody.innerHTML = '';
  const dnis = Object.keys(employeesDatabase).filter(dni => isEmployeeVisibleInMonth(employeesDatabase[dni], monthIndex, year));
  
  if (dnis.length === 0) {
    tbody.innerHTML = '<tr><td colspan="11" class="text-center text-muted" style="padding: 25px;">No hay colaboradores registrados.</td></tr>';
    return;
  }

  const rowDataList = dnis.map(dni => {
    const employee = employeesDatabase[dni];
    const isFlexible = (employee.workStart === "-" || employee.workStart === "—" || employee.weeklySchedule === "flexible");
    
    let diasLaborables = 0;
    let diasAsistidos = 0;
    let faltas = 0;
    let diasJustificados = 0;
    let tardanzasCount = 0;
    let tardanzasSeconds = 0;
    let excessBreakSeconds = 0;
    let totalWorkedSeconds = 0;
    let diasFeriados = 0;
    let diasDescanso = 0;
    let horasExtraSeconds = 0;
    let horasAdicionalesSeconds = 0;

    let schedObj = employee.weeklySchedule;
    if (typeof schedObj === 'string' && schedObj.trim() !== '') {
      try {
        schedObj = JSON.parse(schedObj);
      } catch (e) {
        schedObj = null;
      }
    }
    if (!schedObj) {
      schedObj = {};
    }

    for (let day = 1; day <= totalDaysInMonth; day++) {
      const dateStr = `${String(day).padStart(2, '0')}/${String(monthIndex + 1).padStart(2, '0')}/${year}`;
      const dayStr = String(day).padStart(2, '0');
      const monthStrPad = String(monthIndex + 1).padStart(2, '0');
      const dayMonth = `${dayStr}/${monthStrPad}`;
      
      const d = new Date(year, monthIndex, day);
      const dayOfWeek = d.getDay();

      const empStatusForDate = getEmployeeStatusForDate(employee, dateStr);
      if (empStatusForDate === 'BAJA') {
        // Dado de baja en esta fecha: no genera día laborable ni falta
        continue;
      }

      const isCustomHoliday = feriadosDatabase.some(f => normalizeDateStr(f.dateStr) === normalizeDateStr(dateStr));
      const isHoliday = GLOBAL_FERIADOS.includes(dayMonth) || isCustomHoliday;

      let isRestDay = false;
      if (schedObj[dayOfWeek]) {
        isRestDay = !!schedObj[dayOfWeek].isRestDay;
      } else {
        isRestDay = (dayOfWeek === 0);
      }

      const isWorkday = !isRestDay && !isHoliday;
      const isPastOrToday = (year < now.getFullYear()) || 
                            (year === now.getFullYear() && monthIndex < now.getMonth()) || 
                            (year === now.getFullYear() && monthIndex === now.getMonth() && day <= now.getDate());

      if (isPastOrToday) {
        if (isWorkday) {
          diasLaborables++;
        } else if (isHoliday) {
          diasFeriados++;
        } else if (isRestDay) {
          diasDescanso++;
        }
      }

      const dayMarks = dataMap[dni] && dataMap[dni][dateStr] ? dataMap[dni][dateStr] : null;
      const hasIngreso = dayMarks && dayMarks.some(m => m.action === 'Ingreso');

      if (hasIngreso) {
        dayMarks.sort((a, b) => a.timestamp - b.timestamp);
        const report = calculateWorkedTimesForDate(dayMarks, employee, dateStr);

        if (isWorkday) {
          diasAsistidos++;
          
          if (report.tardiness) {
            tardanzasCount++;
            const actualEntrySec = timeStrToSeconds(report.entradaReal);
            let schedEntry = "08:00";
            if (schedObj[dayOfWeek] && schedObj[dayOfWeek].workStart) {
              schedEntry = schedObj[dayOfWeek].workStart;
            } else if (dayOfWeek === 6) {
              schedEntry = employee.workStart || "09:00";
            } else {
              schedEntry = employee.workStart || "08:00";
            }
            const scheduledEntrySec = timeStrToSeconds(schedEntry);
            const diff = actualEntrySec - scheduledEntrySec;
            if (diff > 0) {
              tardanzasSeconds += diff;
            }
          }

          if (report.excessBreakSeconds > 0) {
            excessBreakSeconds += report.excessBreakSeconds;
          }
          
          if (report.horasAdicionalesSeconds > 0) {
            horasAdicionalesSeconds += report.horasAdicionalesSeconds;
          }
        } else {
          if (report.workedSeconds > 0) {
            horasExtraSeconds += report.workedSeconds;
          }
        }

        if (report.workedSeconds > 0) {
          totalWorkedSeconds += report.workedSeconds;
        }
      } else {
        if (isWorkday && isPastOrToday && !isFlexible) {
          const justification = justificacionesDatabase.find(j => 
            String(j.dni) === String(dni) && 
            normalizeDateStr(j.dateStr) === normalizeDateStr(dateStr)
          );
          if (justification) {
            diasJustificados++;
          } else {
            faltas++;
          }
        }
      }
    }

    return {
      dni,
      name: employee.name,
      diasLaborables,
      diasAsistidos,
      faltas,
      diasJustificados,
      tardanzasCount,
      tardanzasSeconds,
      excessBreakSeconds,
      totalWorkedSeconds,
      horasAdicionalesSeconds
    };
  });

  // Ordenar lista de datos según la columna activa
  rowDataList.sort((a, b) => {
    let valA = a[monthlySortCol];
    let valB = b[monthlySortCol];
    if (typeof valA === 'string') {
      valA = valA.toLowerCase();
      valB = valB.toLowerCase();
    }
    if (valA < valB) return monthlySortDir === 'asc' ? -1 : 1;
    if (valA > valB) return monthlySortDir === 'asc' ? 1 : -1;
    return 0;
  });

  tbody.innerHTML = '';
  rowDataList.forEach(row => {
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td class="table-employee-name" style="font-weight: 500;">${row.name}</td>
      <td>${row.dni}</td>
      <td class="text-center">${row.diasLaborables}</td>
      <td class="text-center">${row.diasAsistidos}</td>
      <td class="text-center" style="font-weight: 600; color: ${row.faltas > 0 ? 'var(--color-error)' : 'var(--text-secondary)'};">${row.faltas}</td>
      <td class="text-center" style="font-weight: 600; color: ${row.diasJustificados > 0 ? '#ffa500' : 'var(--text-secondary)'};">${row.diasJustificados}</td>
      <td class="text-center" style="font-weight: 600; color: ${row.tardanzasCount > 0 ? 'var(--color-warning)' : 'var(--text-secondary)'};">${row.tardanzasCount}</td>
      <td class="text-center" style="${row.tardanzasSeconds > 0 ? 'color: #ff4d4d; font-weight: 600;' : ''}">${row.tardanzasSeconds > 0 ? formatSecondsToHHMMSS(row.tardanzasSeconds) : '00:00:00'}</td>
      <td class="text-center" style="color: ${row.excessBreakSeconds > 0 ? 'var(--color-warning)' : 'var(--text-secondary)'};">${row.excessBreakSeconds > 0 ? formatSecondsToHHMMSS(row.excessBreakSeconds) : '00:00:00'}</td>
      <td class="text-center cell-total-worked">${row.totalWorkedSeconds > 0 ? formatSecondsToHHMMSS(row.totalWorkedSeconds) : '00:00:00'}</td>
      <td class="text-center" style="font-weight: 600; color: var(--text-primary);">${row.horasAdicionalesSeconds > 0 ? formatSecondsToHHMMSS(row.horasAdicionalesSeconds) : '00:00:00'}</td>
    `;
    tbody.appendChild(tr);
  });
}


function exportMonthlyExcel() {
  const monthInput = document.getElementById('monthly-select-month');
  if (!monthInput || !monthInput.value) {
    showToast('warning', 'Selecciona mes', 'Primero debes elegir un mes para exportar.');
    return;
  }
  const selectedMonth = monthInput.value;
  const [yearStr, monthStr] = selectedMonth.split('-');
  const year = parseInt(yearStr, 10);
  const monthIndex = parseInt(monthStr, 10) - 1;

  const history = getAllCachedHistory();
  
  const normalizedHistory = history.map(item => {
    const normDate = normalizeDateStr(item.dateStr);
    const normTime = normalizeTimeStr(item.timeStr);
    const ts = getTimestampFromDateAndTime(normDate, normTime);
    return {
      ...item,
      dateStr: normDate,
      timeStr: normTime,
      timestamp: ts
    };
  }).filter(item => {
    if (!item.dni || !employeesDatabase[item.dni] || !item.dateStr) return false;
    const parts = item.dateStr.split('/');
    if (parts.length !== 3) return false;
    const itemYear = parseInt(parts[2], 10);
    const itemMonth = parseInt(parts[1], 10);
    return itemYear === year && itemMonth === (monthIndex + 1);
  });

  const dataMap = {};
  normalizedHistory.forEach(item => {
    if (!dataMap[item.dni]) dataMap[item.dni] = {};
    if (!dataMap[item.dni][item.dateStr]) dataMap[item.dni][item.dateStr] = [];
    dataMap[item.dni][item.dateStr].push(item);
  });

  const now = new Date();
  let lastDay = new Date(year, monthIndex + 1, 0).getDate();
  if (year === now.getFullYear() && monthIndex === now.getMonth()) {
    lastDay = now.getDate();
  } else if (year > now.getFullYear() || (year === now.getFullYear() && monthIndex > now.getMonth())) {
    lastDay = 0;
  }

  const FERIADOS = [
    "01/01", "01/05", "29/06", "23/07", "28/07", "29/07", 
    "06/08", "30/08", "08/10", "01/11", "08/12", "09/12", "25/12"
  ];

  const wb = XLSX.utils.book_new();
  const rows = [];
  
  rows.push([`Resumen Mensual de Asistencia - ${selectedMonth}`]);
  rows.push([]);
  
  const header = [
    "Colaborador", "DNI", "Días Laborables", "Días Asistidos", "Faltas", 
    "Días Justificados", "Tardanzas (Cant.)", "Tardanzas (Acum.)", 
    "Exceso Break (Acum.)", "Trabajo Real (Total)", "Horas Extra"
  ];
  rows.push(header);

  const dnis = Object.keys(employeesDatabase).filter(dni => isEmployeeVisibleInMonth(employeesDatabase[dni], monthIndex, year));
  dnis.forEach(dni => {
    const employee = employeesDatabase[dni];
    const isFlexible = (employee.workStart === "-" || employee.workStart === "—" || employee.weeklySchedule === "flexible");
    
    let diasLaborables = 0;
    let diasAsistidos = 0;
    let faltas = 0;
    let diasJustificados = 0;
    let tardanzasCount = 0;
    let tardanzasSeconds = 0;
    let excessBreakSeconds = 0;
    let totalWorkedSeconds = 0;
    let horasAdicionalesSeconds = 0;

    let schedObj = employee.weeklySchedule;
    if (typeof schedObj === 'string' && schedObj.trim() !== '') {
      try {
        schedObj = JSON.parse(schedObj);
      } catch (e) {
        schedObj = null;
      }
    }
    if (!schedObj) schedObj = {};

    for (let day = 1; day <= lastDay; day++) {
      const dateStr = `${String(day).padStart(2, '0')}/${String(monthIndex + 1).padStart(2, '0')}/${year}`;
      const dayStr = String(day).padStart(2, '0');
      const monthStrPad = String(monthIndex + 1).padStart(2, '0');
      const dayMonth = `${dayStr}/${monthStrPad}`;
      
      const d = new Date(year, monthIndex, day);
      const dayOfWeek = d.getDay();

      const empStatusForDate = getEmployeeStatusForDate(employee, dateStr);
      if (empStatusForDate === 'BAJA') {
        continue;
      }

      const isCustomHoliday = feriadosDatabase.some(f => normalizeDateStr(f.dateStr) === normalizeDateStr(dateStr));
      const isHoliday = GLOBAL_FERIADOS.includes(dayMonth) || isCustomHoliday;

      let isRestDay = false;
      if (schedObj[dayOfWeek]) {
        isRestDay = !!schedObj[dayOfWeek].isRestDay;
      } else {
        isRestDay = (dayOfWeek === 0);
      }

      const isWorkday = !isRestDay && !isHoliday;
      if (isWorkday) diasLaborables++;

      const dayMarks = dataMap[dni] && dataMap[dni][dateStr] ? dataMap[dni][dateStr] : null;
      const hasIngreso = dayMarks && dayMarks.some(m => m.action === 'Ingreso');

      if (hasIngreso) {
        dayMarks.sort((a, b) => a.timestamp - b.timestamp);
        const report = calculateWorkedTimesForDate(dayMarks, employee, dateStr);
        
        if (isWorkday) {
          diasAsistidos++;
          
          if (report.tardiness) {
            tardanzasCount++;
            const actualEntrySec = timeStrToSeconds(report.entradaReal);
            let schedEntry = "08:00";
            if (schedObj[dayOfWeek] && schedObj[dayOfWeek].workStart) {
              schedEntry = schedObj[dayOfWeek].workStart;
            } else if (dayOfWeek === 6) {
              schedEntry = employee.workStart || "09:00";
            } else {
              schedEntry = employee.workStart || "08:00";
            }
            const scheduledEntrySec = timeStrToSeconds(schedEntry);
            const diff = actualEntrySec - scheduledEntrySec;
            if (diff > 0) tardanzasSeconds += diff;
          }

          if (report.excessBreakSeconds > 0) excessBreakSeconds += report.excessBreakSeconds;
          if (report.horasAdicionalesSeconds > 0) horasAdicionalesSeconds += report.horasAdicionalesSeconds;
        }
        
        if (report.workedSeconds > 0) totalWorkedSeconds += report.workedSeconds;
      } else {
        if (isWorkday && !isFlexible) {
          const justification = justificacionesDatabase.find(j => 
            String(j.dni) === String(dni) && 
            normalizeDateStr(j.dateStr) === normalizeDateStr(dateStr)
          );
          if (justification) {
            diasJustificados++;
          } else {
            faltas++;
          }
        }
      }
    }

    const tardAcumStr = tardanzasSeconds > 0 ? formatSecondsToHHMMSS(tardanzasSeconds) : '00:00:00';
    const breakAcumStr = excessBreakSeconds > 0 ? formatSecondsToHHMMSS(excessBreakSeconds) : '00:00:00';
    const workedTotalStr = totalWorkedSeconds > 0 ? formatSecondsToHHMMSS(totalWorkedSeconds) : '00:00:00';
    const extraHrsStr = horasAdicionalesSeconds > 0 ? formatSecondsToHHMMSS(horasAdicionalesSeconds) : '00:00:00';

    rows.push([
      employee.name,
      dni,
      diasLaborables,
      diasAsistidos,
      faltas,
      diasJustificados,
      tardanzasCount,
      tardAcumStr,
      breakAcumStr,
      workedTotalStr,
      extraHrsStr
    ]);
  });

  const ws = XLSX.utils.aoa_to_sheet(rows);
  
  // Auto-ajustar columnas
  const colWidths = header.map((_, colIndex) => {
    const maxLen = Math.max(...rows.slice(2).map(row => row[colIndex] ? String(row[colIndex]).length : 0));
    return { wch: Math.max(12, maxLen + 3) };
  });
  ws['!cols'] = colWidths;
  
  XLSX.utils.book_append_sheet(wb, ws, "Resumen Mensual");
  XLSX.writeFile(wb, `Reporte_Mensual_Asistencia_${selectedMonth}.xlsx`);
  showToast('success', 'Exportación Completa', 'Se descargó el reporte mensual en formato Excel (.xlsx).');
}

// ==========================================================================
// FUNCIONALIDADES DE LA FASE 3: JUSTIFICACIONES, FERIADOS Y RESUMEN SEMANAL
// ==========================================================================

function syncJustificacionesFromGoogleSheets() {
  if (!googleScriptUrl) return Promise.resolve();
  return fetch(getScriptUrlWithApiKey('get_justificaciones'))
    .then(res => res.json())
    .then(res => {
      if (res.status === "ok" && Array.isArray(res.data)) {
        justificacionesDatabase = res.data;
        safeSetItem('justificaciones_db', JSON.stringify(justificacionesDatabase));
        renderJustificacionesTable();
        console.log("Justificaciones sincronizadas desde Google Sheets.");
      }
    })
    .catch(err => console.error("Error al sincronizar justificaciones:", err));
}

function syncFeriadosFromGoogleSheets() {
  if (!googleScriptUrl) return Promise.resolve();
  return fetch(getScriptUrlWithApiKey('get_feriados'))
    .then(res => res.json())
    .then(res => {
      if (res.status === "ok" && Array.isArray(res.data)) {
        feriadosDatabase = res.data;
        safeSetItem('feriados_db', JSON.stringify(feriadosDatabase));
        renderFeriadosTable();
        console.log("Feriados sincronizados desde Google Sheets.");
      }
    })
    .catch(err => console.error("Error al sincronizar feriados:", err));
}

function renderJustificacionesTable() {
  const tbody = document.getElementById('justificaciones-table-body');
  if (!tbody) return;
  
  if (justificacionesDatabase.length === 0) {
    tbody.innerHTML = '<tr><td colspan="5" class="text-center text-muted" style="padding: 15px;">No hay justificaciones registradas.</td></tr>';
    return;
  }
  
  tbody.innerHTML = '';
  justificacionesDatabase.forEach(item => {
    const employee = employeesDatabase[item.dni] || { name: `DNI: ${item.dni}` };
    let typeBadge = `<span class="badge" style="background: var(--bg-inner); color: var(--text-primary); font-weight: 500; padding: 4px 8px; border-radius: 4px;">${item.type}</span>`;
    if (item.type === 'Permiso por Horas' && item.startTime && item.endTime) {
      const compLabel = item.compensation === 'Sin goce' ? 'Sin goce' : 'Con goce';
      const compColor = item.compensation === 'Sin goce' ? '#f59e0b' : '#10b981';
      typeBadge = `<div style="display: flex; flex-direction: column; gap: 4px;">
        <span class="badge" style="background: rgba(30, 144, 255, 0.1); color: #1e90ff; font-weight: 600; padding: 4px 8px; border-radius: 4px; font-size: 0.85rem; width: fit-content;">Permiso por Horas</span>
        <span style="font-size: 0.8rem; color: var(--text-secondary); font-weight: 500;">⏱️ ${item.startTime} a ${item.endTime}</span>
        <span style="font-size: 0.75rem; color: ${compColor}; font-weight: 600;">${compLabel}</span>
      </div>`;
    }

    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td>${employee.name}</td>
      <td class="text-center">${item.dateStr}</td>
      <td>${typeBadge}</td>
      <td style="max-width: 250px; white-space: normal; word-break: break-word;">${item.details || '—'}</td>
      <td class="text-center">
        <button class="btn-delete-justification btn-table-action" data-dni="${item.dni}" data-date="${item.dateStr}" style="padding: 4px 8px; font-size: 0.8rem; border-color: rgba(220, 20, 60, 0.4); color: #ff4d4d; display: inline-flex; align-items: center; gap: 4px; background: transparent; cursor: pointer; border: 1px solid var(--border-color); border-radius: 4px;">
          <span class="material-symbols-rounded" style="font-size: 14px;">delete</span>
          <span>Eliminar</span>
        </button>
      </td>
    `;
    tbody.appendChild(tr);
  });

  tbody.querySelectorAll('.btn-delete-justification').forEach(btn => {
    btn.addEventListener('click', function() {
      const dni = this.getAttribute('data-dni');
      const date = this.getAttribute('data-date');
      deleteJustificacion(dni, date);
    });
  });
}

function renderFeriadosTable() {
  const tbody = document.getElementById('feriados-table-body');
  if (!tbody) return;
  
  const selectYear = document.getElementById('filter-holiday-year');
  
  // Obtener año actual
  const currentYear = new Date().getFullYear();
  
  // Recopilar todos los años de los feriados y el año actual
  const years = new Set([currentYear]);
  feriadosDatabase.forEach(f => {
    const parts = f.dateStr.split('/');
    if (parts.length === 3) {
      const y = parseInt(parts[2], 10);
      if (!isNaN(y)) years.add(y);
    }
  });
  
  // Ordenar años de manera ascendente
  const sortedYears = Array.from(years).sort((a, b) => a - b);
  
  // Guardar el valor seleccionado actual (o año actual por defecto)
  let selectedYear = selectYear ? parseInt(selectYear.value, 10) : currentYear;
  if (isNaN(selectedYear)) selectedYear = currentYear;
  
  // Si hay el dropdown en el HTML, regenerar las opciones
  if (selectYear) {
    const prevVal = selectYear.value;
    selectYear.innerHTML = '';
    sortedYears.forEach(y => {
      const opt = document.createElement('option');
      opt.value = y;
      opt.textContent = y;
      if (y === selectedYear) opt.selected = true;
      selectYear.appendChild(opt);
    });
    
    // Si el valor anterior existía y sigue estando en la lista, mantenerlo
    if (prevVal && sortedYears.includes(parseInt(prevVal, 10))) {
      selectYear.value = prevVal;
      selectedYear = parseInt(prevVal, 10);
    } else {
      selectYear.value = selectedYear;
    }
  }
  
  // Filtrar los feriados por el año seleccionado
  const filteredFeriados = feriadosDatabase.filter(item => {
    const parts = item.dateStr.split('/');
    if (parts.length === 3) {
      return parseInt(parts[2], 10) === selectedYear;
    }
    return false;
  });
  
  if (filteredFeriados.length === 0) {
    tbody.innerHTML = `<tr><td colspan="3" class="text-center text-muted" style="padding: 15px;">No hay feriados para el año ${selectedYear}.</td></tr>`;
    return;
  }
  
  // Ordenar de manera cronológica ascendente (enero a diciembre)
  const sortedFeriados = [...filteredFeriados].sort((a, b) => {
    const partsA = a.dateStr.split('/');
    const partsB = b.dateStr.split('/');
    const dateA = new Date(partsA[2], partsA[1]-1, partsA[0]);
    const dateB = new Date(partsB[2], partsB[1]-1, partsB[0]);
    return dateA - dateB;
  });

  tbody.innerHTML = '';
  sortedFeriados.forEach(item => {
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td class="text-center">${item.dateStr}</td>
      <td>${item.name}</td>
      <td class="text-center">
        <button class="btn-delete-holiday btn-table-action" data-date="${item.dateStr}" style="padding: 4px 8px; font-size: 0.8rem; border-color: rgba(220, 20, 60, 0.4); color: #ff4d4d; display: inline-flex; align-items: center; gap: 4px; background: transparent; cursor: pointer; border: 1px solid var(--border-color); border-radius: 4px;">
          <span class="material-symbols-rounded" style="font-size: 14px;">delete</span>
          <span>Eliminar</span>
        </button>
      </td>
    `;
    tbody.appendChild(tr);
  });

  tbody.querySelectorAll('.btn-delete-holiday').forEach(btn => {
    btn.addEventListener('click', function() {
      const date = this.getAttribute('data-date');
      deleteFeriado(date);
    });
  });
}

function registerJustificacion(dni, dateStr, type, details, startTime = '', endTime = '', compensation = '') {
  const payload = {
    action: "Registrar_Justificacion",
    apiKey: googleScriptApiKey,
    employeeId: dni,
    date: dateStr,
    type: type,
    details: details,
    startTime: startTime,
    endTime: endTime,
    compensation: compensation
  };

  justificacionesDatabase = justificacionesDatabase.filter(j => !(j.dni === dni && j.dateStr === dateStr));
  justificacionesDatabase.push({ dni, dateStr, type, details, startTime, endTime, compensation });
  safeSetItem('justificaciones_db', JSON.stringify(justificacionesDatabase));
  renderJustificacionesTable();

  if (googleScriptUrl) {
    showToast('info', 'Guardando...', 'Sincronizando justificación con Google Sheets.');
    fetch(getScriptUrlWithApiKey(), {
      method: "POST",
      mode: "no-cors",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    })
    .then(() => {
      showToast('success', 'Sincronizado', 'Justificación registrada exitosamente en Google Sheets.');
      syncJustificacionesFromGoogleSheets();
    })
    .catch(err => {
      console.error("Error al sincronizar justificación:", err);
      showToast('warning', 'Error de red', 'Justificación guardada localmente, pero falló sincronización.');
    });
  } else {
    showToast('success', 'Guardado Local', 'Justificación registrada localmente.');
  }
}

function deleteJustificacion(dni, dateStr) {
  showCustomConfirm({
    title: 'Eliminar Justificación',
    message: `¿Estás seguro de que deseas eliminar la justificación de la fecha <strong>${dateStr}</strong>?<br><span style="font-size: 0.85rem; color: var(--text-muted);">Esta acción no se puede deshacer.</span>`,
    type: 'danger',
    acceptText: 'Eliminar'
  }).then((confirmed) => {
    if (confirmed) {
      const payload = {
        action: "Eliminar_Justificacion",
        apiKey: googleScriptApiKey,
        employeeId: dni,
        date: dateStr
      };

      justificacionesDatabase = justificacionesDatabase.filter(j => !(String(j.dni).trim() === String(dni).trim() && j.dateStr === dateStr));
      safeSetItem('justificaciones_db', JSON.stringify(justificacionesDatabase));
      renderJustificacionesTable();

      if (googleScriptUrl) {
        showToast('info', 'Eliminando...', 'Sincronizando eliminación con Google Sheets.');
        fetch(getScriptUrlWithApiKey(), {
          method: "POST",
          mode: "no-cors",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload)
        })
        .then(() => {
          showToast('success', 'Eliminado', 'Justificación eliminada de Google Sheets.');
          setTimeout(() => {
            syncJustificacionesFromGoogleSheets();
          }, 1500);
        })
        .catch(err => {
          console.error("Error al eliminar justificación:", err);
          showToast('warning', 'Error de red', 'Eliminado localmente, falló sincronización.');
        });
      } else {
        showToast('success', 'Eliminado', 'Justificación eliminada localmente.');
      }
    }
  });
}

function registerFeriado(dateStr, name) {
  const payload = {
    action: "Registrar_Feriado",
    apiKey: googleScriptApiKey,
    date: dateStr,
    name: name
  };

  feriadosDatabase = feriadosDatabase.filter(f => f.dateStr !== dateStr);
  feriadosDatabase.push({ dateStr, name });
  safeSetItem('feriados_db', JSON.stringify(feriadosDatabase));

  // Seleccionar automáticamente el año del feriado recién registrado
  const parts = dateStr.split('/');
  if (parts.length === 3) {
    const y = parts[2];
    const selectYear = document.getElementById('filter-holiday-year');
    if (selectYear) {
      let hasOption = false;
      for (let i = 0; i < selectYear.options.length; i++) {
        if (selectYear.options[i].value === y) {
          hasOption = true;
          break;
        }
      }
      if (!hasOption) {
        const opt = document.createElement('option');
        opt.value = y;
        opt.textContent = y;
        selectYear.appendChild(opt);
      }
      selectYear.value = y;
    }
  }

  renderFeriadosTable();

  if (googleScriptUrl) {
    showToast('info', 'Guardando...', 'Sincronizando feriado con Google Sheets.');
    fetch(getScriptUrlWithApiKey(), {
      method: "POST",
      mode: "no-cors",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    })
    .then(() => {
      showToast('success', 'Sincronizado', 'Feriado registrado exitosamente en Google Sheets.');
      syncFeriadosFromGoogleSheets();
    })
    .catch(err => {
      console.error("Error al sincronizar feriado:", err);
      showToast('warning', 'Error de red', 'Feriado guardado localmente, pero falló sincronización.');
    });
  } else {
    showToast('success', 'Guardado Local', 'Feriado registrado localmente.');
  }
}

function deleteFeriado(dateStr) {
  showCustomConfirm({
    title: 'Eliminar Feriado',
    message: `¿Estás seguro de que deseas eliminar el feriado de la fecha <strong>${dateStr}</strong>?<br><span style="font-size: 0.85rem; color: var(--text-muted);">Esta acción no se puede deshacer.</span>`,
    type: 'danger',
    acceptText: 'Eliminar'
  }).then((confirmed) => {
    if (confirmed) {
      const payload = {
        action: "Eliminar_Feriado",
        apiKey: googleScriptApiKey,
        date: dateStr
      };

      feriadosDatabase = feriadosDatabase.filter(f => f.dateStr !== dateStr);
      safeSetItem('feriados_db', JSON.stringify(feriadosDatabase));
      renderFeriadosTable();

      if (googleScriptUrl) {
        showToast('info', 'Eliminando...', 'Sincronizando eliminación con Google Sheets.');
        fetch(getScriptUrlWithApiKey(), {
          method: "POST",
          mode: "no-cors",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload)
        })
        .then(() => {
          showToast('success', 'Eliminado', 'Feriado eliminado de Google Sheets.');
          setTimeout(() => {
            syncFeriadosFromGoogleSheets();
          }, 1500);
        })
        .catch(err => {
          console.error("Error al eliminar feriado:", err);
          showToast('warning', 'Error de red', 'Eliminado localmente, falló sincronización.');
        });
      } else {
        showToast('success', 'Eliminado', 'Feriado eliminado localmente.');
      }
    }
  });
}

function getCurrentWeekDates() {
  const dates = [];
  const today = new Date();
  
  const dayOfWeek = today.getDay();
  const diffToMonday = today.getDate() - (dayOfWeek === 0 ? 6 : dayOfWeek - 1);
  
  const monday = new Date(today);
  monday.setDate(diffToMonday);
  
  for (let i = 0; i < 7; i++) {
    const day = new Date(monday);
    day.setDate(monday.getDate() + i);
    
    const dStr = String(day.getDate()).padStart(2, '0');
    const mStr = String(day.getMonth() + 1).padStart(2, '0');
    const yStr = day.getFullYear();
    dates.push(`${dStr}/${mStr}/${yStr}`);
  }
  return dates;
}

function renderEmployeeWeeklySummary(dni) {
  const employee = employeesDatabase[dni];
  if (!employee) return;
  
  const gridContainer = document.getElementById('weekly-days-grid');
  if (!gridContainer) return;
  
  const weekDates = getCurrentWeekDates();
  const history = attendanceState[dni].history || [];
  
  const groupedMarks = {};
  history.forEach(item => {
    const norm = normalizeDateStr(item.dateStr);
    if (!groupedMarks[norm]) groupedMarks[norm] = [];
    groupedMarks[norm].push(item);
  });
  
  let totalWorkedSec = 0;
  let totalTardinessMin = 0;
  
  gridContainer.innerHTML = '';
  const dayNames = ["Lunes", "Martes", "Miércoles", "Jueves", "Viernes", "Sábado", "Domingo"];
  const todayDate = new Date();
  todayDate.setHours(0,0,0,0);
  
  weekDates.forEach((dateStr, index) => {
    const dayName = dayNames[index];
    const normDate = normalizeDateStr(dateStr);
    const dayMarks = groupedMarks[normDate] || [];
    
    const parts = dateStr.split('/');
    const dObj = new Date(parseInt(parts[2], 10), parseInt(parts[1], 10) - 1, parseInt(parts[0], 10));
    dObj.setHours(0,0,0,0);
    const isFuture = dObj > todayDate;
    const isToday = dObj.getTime() === todayDate.getTime();
    
    const justification = justificacionesDatabase.find(j => 
      String(j.dni) === String(dni) && 
      normalizeDateStr(j.dateStr) === normDate
    );
    
    const FERIADOS = [
      "01/01", "01/05", "29/06", "23/07", "28/07", "29/07", 
      "06/08", "30/08", "08/10", "01/11", "08/12", "09/12", "25/12"
    ];
    const dayStr = String(dObj.getDate()).padStart(2, '0');
    const monthStr = String(dObj.getMonth() + 1).padStart(2, '0');
    const dayMonth = `${dayStr}/${monthStr}`;
    const isStaticHoliday = GLOBAL_FERIADOS.includes(dayMonth);
    const customHoliday = feriadosDatabase.find(f => normalizeDateStr(f.dateStr) === normDate);
    const isHoliday = isStaticHoliday || !!customHoliday;
    const holidayName = customHoliday ? customHoliday.name : (isStaticHoliday ? "Feriado Nacional" : "");
    
    let dayOfWeek = dObj.getDay();
    let daySched = null;
    let schedObj = employee.weeklySchedule;
    if (typeof schedObj === 'string' && schedObj.trim() !== '') {
      try { schedObj = JSON.parse(schedObj); } catch(e) { schedObj = null; }
    }
    if (schedObj && schedObj[dayOfWeek]) {
      daySched = schedObj[dayOfWeek];
    }
    if (!daySched) {
      if (dayOfWeek === 0) daySched = { isRestDay: true };
      else if (dayOfWeek === 6) daySched = { isRestDay: false, workStart: employee.workStart || "09:00", workEnd: "13:00", expectedHours: 4, nobreak: true };
      else daySched = { isRestDay: false, workStart: employee.workStart || "08:00", workEnd: employee.workEnd || "17:00", expectedHours: 8 };
    }
    
    const report = calculateWorkedTimesForDate(dayMarks, employee, dateStr);
    const hasIngreso = dayMarks.some(m => m.action === 'Ingreso');
    const workedHrMin = formatSecondsToHHMMSS(report.workedSeconds);
    
    if (hasIngreso) {
      totalWorkedSec += report.workedSeconds;
      
      let tardinessTimeStr = "";
      if (report.tardiness) {
        const actualEntrySec = timeStrToSeconds(report.entradaReal);
        const schedEntry = daySched.workStart || "08:00";
        const scheduledEntrySec = timeStrToSeconds(schedEntry);
        const diff = actualEntrySec - scheduledEntrySec;
        if (diff > 0) {
          const tardMin = Math.ceil(diff / 60);
          totalTardinessMin += tardMin;
        }
      }
    }
    
    let cardHTML = '';
    
    if (justification) {
      const workedBadge = hasIngreso ? `<span style="font-size: 0.65rem; color: #2e8b57; font-weight: 600; margin-top: 2px;">Trabajado (${workedHrMin})</span>` : '';
      cardHTML = `
        <div class="weekly-day-card" style="background: rgba(230, 81, 0, 0.05); border: 1px solid rgba(230, 81, 0, 0.2); border-radius: var(--radius-md); padding: 12px; text-align: center; display: flex; flex-direction: column; gap: 8px;">
          <span style="font-size: 0.8rem; font-weight: 600; color: var(--text-secondary); text-transform: uppercase;">${dayName}</span>
          <span class="material-symbols-rounded" style="color: #e65100; font-size: 22px;">event_busy</span>
          <div style="display: flex; flex-direction: column; gap: 2px;">
            <span style="font-size: 0.75rem; color: #e65100; font-weight: 600;" title="${justification.details}">${justification.type}</span>
            <span style="font-size: 0.65rem; color: var(--text-muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">${justification.details}</span>
            ${workedBadge}
          </div>
        </div>
      `;
    } else if (isHoliday) {
      const workedBadge = hasIngreso ? `<span style="font-size: 0.65rem; color: #2e8b57; font-weight: 600; margin-top: 2px;">Trabajado (${workedHrMin})</span>` : '';
      cardHTML = `
        <div class="weekly-day-card" style="background: rgba(30, 144, 255, 0.05); border: 1px solid rgba(30, 144, 255, 0.2); border-radius: var(--radius-md); padding: 12px; text-align: center; display: flex; flex-direction: column; gap: 8px;">
          <span style="font-size: 0.8rem; font-weight: 600; color: var(--text-secondary); text-transform: uppercase;">${dayName}</span>
          <span class="material-symbols-rounded" style="color: #1e90ff; font-size: 22px;">celebration</span>
          <div style="display: flex; flex-direction: column; gap: 2px;">
            <span style="font-size: 0.75rem; color: #1e90ff; font-weight: 600;" title="${holidayName}">Feriado</span>
            <span style="font-size: 0.65rem; color: var(--text-muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">${holidayName}</span>
            ${workedBadge}
          </div>
        </div>
      `;
    } else if (hasIngreso) {
      if (report.tardiness) {
        let tardinessTimeStr = "";
        const actualEntrySec = timeStrToSeconds(report.entradaReal);
        const schedEntry = daySched.workStart || "08:00";
        const scheduledEntrySec = timeStrToSeconds(schedEntry);
        const diff = actualEntrySec - scheduledEntrySec;
        if (diff > 0) {
          const tardMin = Math.ceil(diff / 60);
          tardinessTimeStr = `${tardMin}m de tardanza`;
        }
        cardHTML = `
          <div class="weekly-day-card" style="background: rgba(220, 20, 60, 0.05); border: 1px solid rgba(220, 20, 60, 0.2); border-radius: var(--radius-md); padding: 12px; text-align: center; display: flex; flex-direction: column; gap: 8px;">
            <span style="font-size: 0.8rem; font-weight: 600; color: var(--text-secondary); text-transform: uppercase;">${dayName}</span>
            <span class="material-symbols-rounded" style="color: #ff4d4d; font-size: 22px;">warning</span>
            <div style="display: flex; flex-direction: column; gap: 2px;">
              <span style="font-size: 0.75rem; color: #ff4d4d; font-weight: 600;">Tardanza (${workedHrMin})</span>
              <span style="font-size: 0.65rem; color: var(--text-muted);">${report.entradaReal} → ${report.salidaReal}</span>
              <span style="font-size: 0.65rem; color: #ff4d4d; font-weight: 500;">${tardinessTimeStr}</span>
            </div>
          </div>
        `;
      } else {
        cardHTML = `
          <div class="weekly-day-card" style="background: rgba(46, 139, 87, 0.05); border: 1px solid rgba(46, 139, 87, 0.2); border-radius: var(--radius-md); padding: 12px; text-align: center; display: flex; flex-direction: column; gap: 8px;">
            <span style="font-size: 0.8rem; font-weight: 600; color: var(--text-secondary); text-transform: uppercase;">${dayName}</span>
            <span class="material-symbols-rounded" style="color: #2e8b57; font-size: 22px;">check_circle</span>
            <div style="display: flex; flex-direction: column; gap: 2px;">
              <span style="font-size: 0.75rem; color: #2e8b57; font-weight: 600;">Trabajado (${workedHrMin})</span>
              <span style="font-size: 0.65rem; color: var(--text-muted);">${report.entradaReal} → ${report.salidaReal}</span>
            </div>
          </div>
        `;
      }
    } else if (daySched.isRestDay) {
      cardHTML = `
        <div class="weekly-day-card" style="background: var(--surface-1); border: 1px solid var(--border-color); border-radius: var(--radius-md); padding: 12px; text-align: center; display: flex; flex-direction: column; gap: 8px;">
          <span style="font-size: 0.8rem; font-weight: 600; color: var(--text-secondary); text-transform: uppercase;">${dayName}</span>
          <span class="material-symbols-rounded" style="color: var(--text-muted); font-size: 22px;">bedtime</span>
          <span style="font-size: 0.75rem; color: var(--text-muted); font-weight: 600;">Descanso</span>
        </div>
      `;
    } else if (isFuture) {
      cardHTML = `
        <div class="weekly-day-card" style="background: var(--surface-1); border: 1px dashed var(--border-color); border-radius: var(--radius-md); padding: 12px; text-align: center; display: flex; flex-direction: column; gap: 8px; opacity: 0.7;">
          <span style="font-size: 0.8rem; font-weight: 600; color: var(--text-secondary); text-transform: uppercase;">${dayName}</span>
          <span class="material-symbols-rounded" style="color: var(--text-muted); font-size: 22px;">horizontal_rule</span>
          <span style="font-size: 0.75rem; color: var(--text-muted);">Sin marca</span>
        </div>
      `;
    } else if (isToday) {
      cardHTML = `
        <div class="weekly-day-card" style="background: rgba(30, 144, 255, 0.03); border: 1px solid rgba(30, 144, 255, 0.15); border-radius: var(--radius-md); padding: 12px; text-align: center; display: flex; flex-direction: column; gap: 8px;">
          <span style="font-size: 0.8rem; font-weight: 600; color: var(--text-secondary); text-transform: uppercase;">${dayName}</span>
          <span class="material-symbols-rounded" style="color: var(--text-secondary); font-size: 22px;">hourglass_empty</span>
          <span style="font-size: 0.75rem; color: var(--text-secondary); font-weight: 600;">Pendiente</span>
        </div>
      `;
    } else {
      cardHTML = `
        <div class="weekly-day-card" style="background: rgba(220, 20, 60, 0.05); border: 1px solid rgba(220, 20, 60, 0.2); border-radius: var(--radius-md); padding: 12px; text-align: center; display: flex; flex-direction: column; gap: 8px;">
          <span style="font-size: 0.8rem; font-weight: 600; color: var(--text-secondary); text-transform: uppercase;">${dayName}</span>
          <span class="material-symbols-rounded" style="color: #ff4d4d; font-size: 22px;">cancel</span>
          <span style="font-size: 0.75rem; color: #ff4d4d; font-weight: 600;">Falta</span>
        </div>
      `;
    }
    
    gridContainer.innerHTML += cardHTML;
  });
  
  const rangeLabel = document.getElementById('weekly-range-label');
  if (rangeLabel) {
    rangeLabel.textContent = `Semana: ${weekDates[0]} - ${weekDates[6]}`;
  }

  const totalHoursLabel = document.getElementById('weekly-total-hours');
  const totalTardinessLabel = document.getElementById('weekly-total-tardiness');
  
  if (totalHoursLabel) {
    totalHoursLabel.textContent = formatSecondsToHHMMSS(totalWorkedSec);
  }
  if (totalTardinessLabel) {
    totalTardinessLabel.textContent = `${totalTardinessMin} min`;
    if (totalTardinessMin > 0) {
      totalTardinessLabel.style.color = '#ff4d4d';
    } else {
      totalTardinessLabel.style.color = 'var(--text-primary)';
    }
  }
}

function secondsToHrMinString(totalSeconds) {
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  return `${hours}h ${minutes}m`;
}

/* ==========================================================================
   AGENT PORTAL UPGRADES (Option 1, 2, and 4)
   ========================================================================== */

function setupAgentHistoryListeners() {
  const btnOpen = document.getElementById('btn-open-agent-history');
  const btnClose = document.getElementById('btn-agent-history-close');
  const modal = document.getElementById('modal-agent-history');
  
  const btnCurrent = document.getElementById('btn-agent-history-current');
  const btnPrevious = document.getElementById('btn-agent-history-previous');

  if (btnOpen) {
    btnOpen.addEventListener('click', () => {
      if (btnCurrent && btnPrevious) {
        btnCurrent.className = 'btn-primary';
        btnPrevious.className = 'btn-outline';
      }
      openAgentHistoryModal(true);
    });
  }

  if (btnClose && modal) {
    btnClose.addEventListener('click', () => {
      modal.classList.add('hidden');
    });
  }

  if (btnCurrent) {
    btnCurrent.addEventListener('click', () => {
      btnCurrent.className = 'btn-primary';
      if (btnPrevious) btnPrevious.className = 'btn-outline';
      openAgentHistoryModal(true);
    });
  }

  if (btnPrevious) {
    btnPrevious.addEventListener('click', () => {
      btnPrevious.className = 'btn-primary';
      if (btnCurrent) btnCurrent.className = 'btn-outline';
      openAgentHistoryModal(false);
    });
  }
}

function updateAgentGuideAndSchedule() {
  if (!currentSession) return;

  const dni = currentSession.dni;
  const employee = employeesDatabase[dni];
  if (!employee) return;

  const guideText = document.getElementById('agent-guide-message');
  const scheduleText = document.getElementById('agent-today-schedule-text');

  if (!guideText || !scheduleText) return;

  // 1. Mostrar Información de Horario de Hoy
  const now = new Date();
  const dayOfWeek = now.getDay();
  const todayStr = now.toLocaleDateString('es-ES', { day: 'numeric', month: 'numeric', year: 'numeric' });
  const normToday = normalizeDateStr(todayStr);

  let isHoliday = false;
  const parts = todayStr.split('/');
  if (parts.length >= 2) {
    const dStr = String(parseInt(parts[0], 10)).padStart(2, '0');
    const mStr = String(parseInt(parts[1], 10)).padStart(2, '0');
    const dayMonth = `${dStr}/${mStr}`;
    const FERIADOS = [
      "01/01", "01/05", "29/06", "23/07", "28/07", "29/07", "06/08", "30/08", "08/10", "01/11", "08/12", "09/12", "25/12"
    ];
    isHoliday = GLOBAL_FERIADOS.includes(dayMonth);
    const customHoliday = feriadosDatabase.find(f => normalizeDateStr(f.dateStr) === normToday);
    if (customHoliday) isHoliday = true;
  }

  const justification = justificacionesDatabase.find(j => 
    String(j.dni) === String(dni) && 
    normalizeDateStr(j.dateStr) === normToday
  );

  let daySched = null;
  const isFlexible = (employee.workStart === "—" || employee.weeklySchedule === "flexible");

  if (isFlexible) {
    daySched = { workStart: "—", workEnd: "—", expectedHours: 0, isRestDay: false, nobreak: true, isFlexible: true };
  } else if (employee.weeklySchedule) {
    let schedObj = employee.weeklySchedule;
    if (typeof schedObj === 'string' && schedObj.trim() !== '') {
      try { schedObj = JSON.parse(schedObj); } catch (e) { schedObj = null; }
    }
    if (schedObj && schedObj[dayOfWeek]) {
      daySched = schedObj[dayOfWeek];
    }
  }

  if (!daySched) {
    if (dayOfWeek === 0) daySched = { isRestDay: true, workStart: "---", workEnd: "---", expectedHours: 0 };
    else if (dayOfWeek === 6) daySched = { isRestDay: false, workStart: employee.workStart || "09:00", workEnd: "13:00", expectedHours: 4, nobreak: true };
    else daySched = { isRestDay: false, workStart: employee.workStart || "08:00", workEnd: employee.workEnd || "17:00", expectedHours: 8 };
  }

  const isRestDay = !!daySched.isRestDay;

  if (justification) {
    scheduleText.textContent = `Permiso Justificado: ${justification.type}`;
  } else if (isHoliday) {
    scheduleText.textContent = `Hoy es día Feriado`;
  } else if (isRestDay) {
    scheduleText.textContent = `Hoy es tu día de Descanso programado`;
  } else if (isFlexible) {
    scheduleText.textContent = `Modalidad: Horario Flexible / Sin Horarios`;
  } else {
    const breakStart = employee.breakStart || "13:00";
    const breakEnd = employee.breakEnd || "14:00";
    const noBreakText = daySched.nobreak ? " (Sin refrigerio)" : ` (Break: ${breakStart} a ${breakEnd})`;
    scheduleText.textContent = `Turno hoy: ${daySched.workStart} a ${daySched.workEnd}${noBreakText}`;
  }

  // 2. Establecer Mensaje de Guía Dinámico
  const allHistory = attendanceState[dni].history || [];
  const todayMarks = allHistory.filter(item => normalizeDateStr(item.dateStr) === normToday);

  const hasIngreso = todayMarks.some(m => m.action === 'Ingreso');
  const hasInicioBreak = todayMarks.some(m => m.action === 'Inicio Refrigerio');
  const hasFinBreak = todayMarks.some(m => m.action === 'Fin Refrigerio');
  const hasSalida = todayMarks.some(m => m.action === 'Salida');

  if (justification) {
    guideText.innerHTML = `Tienes un permiso registrado para hoy:<br><strong>${justification.type}</strong> (${justification.details})`;
  } else if (isHoliday) {
    guideText.innerHTML = `¡Hola! Hoy es día feriado oficial. Disfruta de tu descanso.`;
  } else if (isRestDay) {
    guideText.innerHTML = `¡Hola! Hoy es tu día de descanso semanal programado. ¡Que tengas un excelente día!`;
  } else if (hasSalida) {
    guideText.innerHTML = `¡Buen trabajo por hoy! Tu salida ha sido registrada. Jornada finalizada con éxito.`;
  } else if (hasFinBreak) {
    guideText.innerHTML = `Retornaste del refrigerio. Tu siguiente y último paso de hoy es registrar tu <strong>Salida</strong> al terminar tus labores.`;
  } else if (hasInicioBreak) {
    guideText.innerHTML = `Te encuentras en refrigerio. Recuerda marcar <strong>Fin de Refrigerio</strong> al terminar para retomar tus actividades.`;
  } else if (hasIngreso) {
    if (daySched.nobreak || isFlexible) {
      guideText.innerHTML = `Tu jornada laboral está activa. Tu siguiente paso es registrar tu <strong>Salida</strong> al finalizar tus actividades de hoy.`;
    } else {
      guideText.innerHTML = `Tu jornada laboral está activa. Tu siguiente paso es registrar tu <strong>Inicio de Refrigerio</strong> cuando corresponda.`;
    }
  } else {
    guideText.innerHTML = `¡Hola, ${employee.name.split(' ')[0]}! Recuerda registrar tu <strong>Ingreso</strong> para dar inicio a tu jornada de hoy.`;
  }
}

function openAgentHistoryModal(isCurrentMonth = true) {
  const modal = document.getElementById('modal-agent-history');
  const tbody = document.getElementById('agent-history-table-body');
  if (!modal || !tbody) return;

  const dni = currentSession.dni;
  const employee = employeesDatabase[dni];
  if (!employee) return;

  tbody.innerHTML = '';
  modal.classList.remove('hidden');

  const history = (attendanceState[dni] && Array.isArray(attendanceState[dni].history)) ? attendanceState[dni].history : [];
  const now = new Date();
  let year = now.getFullYear();
  let month = now.getMonth(); // 0-indexed

  if (isCurrentMonth === undefined) {
    isCurrentMonth = true;
  }

  if (!isCurrentMonth) {
    month--;
    if (month < 0) {
      month = 11;
      year--;
    }
  }

  // Filtrar historial del agente para el mes seleccionado
  const normalizedHistory = history.map(item => {
    const normDate = normalizeDateStr(item.dateStr);
    const normTime = normalizeTimeStr(item.timeStr);
    const ts = getTimestampFromDateAndTime(normDate, normTime);
    return {
      ...item,
      dateStr: normDate,
      timeStr: normTime,
      timestamp: ts
    };
  }).filter(item => {
    const parts = item.dateStr.split('/');
    if (parts.length !== 3) return false;
    const itemYear = parseInt(parts[2], 10);
    const itemMonth = parseInt(parts[1], 10) - 1;
    return itemYear === year && itemMonth === month;
  });

  // Determinar cuántos días tiene el mes a listar
  let totalDays = 31;
  if (isCurrentMonth) {
    totalDays = now.getDate(); // Listar hasta hoy
  } else {
    // Total de días del mes anterior
    totalDays = new Date(year, month + 1, 0).getDate();
  }

  let html = '';

  for (let dNum = totalDays; dNum >= 1; dNum--) {
    const dStr = String(dNum).padStart(2, '0');
    const mStr = String(month + 1).padStart(2, '0');
    const dateStr = `${dStr}/${mStr}/${year}`;
    const normDate = normalizeDateStr(dateStr);

    const dayMarks = normalizedHistory.filter(item => item.dateStr === normDate);

    let isHoliday = false;
    const dayMonth = `${dStr}/${mStr}`;
    const FERIADOS = [
      "01/01", "01/05", "29/06", "23/07", "28/07", "29/07", "06/08", "30/08", "08/10", "01/11", "08/12", "09/12", "25/12"
    ];
    isHoliday = GLOBAL_FERIADOS.includes(dayMonth);
    const customHoliday = feriadosDatabase.find(f => normalizeDateStr(f.dateStr) === normDate);
    if (customHoliday) isHoliday = true;

    const justification = justificacionesDatabase.find(j => 
      String(j.dni) === String(dni) && 
      normalizeDateStr(j.dateStr) === normDate
    );

    const dObj = new Date(year, month, dNum);
    const dayOfWeek = dObj.getDay();

    const isFlexible = (employee.workStart === "—" || employee.weeklySchedule === "flexible");
    let daySched = null;

    if (isFlexible) {
      daySched = { workStart: "—", workEnd: "—", expectedHours: 0, isRestDay: false, nobreak: true, isFlexible: true };
    } else if (employee.weeklySchedule) {
      let schedObj = employee.weeklySchedule;
      if (typeof schedObj === 'string' && schedObj.trim() !== '') {
        try { schedObj = JSON.parse(schedObj); } catch (e) { schedObj = null; }
      }
      if (schedObj && schedObj[dayOfWeek]) {
        daySched = schedObj[dayOfWeek];
      }
    }

    if (!daySched) {
      if (dayOfWeek === 0) daySched = { isRestDay: true };
      else daySched = { isRestDay: false };
    }

    const isRestDay = !!daySched.isRestDay;

    let entradaDisplay = '---';
    let salidaDisplay = '---';
    let breakDisplay = '00:00:00';
    let workedDisplay = '00:00:00';
    let tardinessDisplay = '---';
    let statusBadge = '';

    if (dayMarks.length > 0) {
      const report = calculateWorkedTimesForDate(dayMarks, employee, dateStr);
      const inMark = dayMarks.find(m => m.action === 'Ingreso');
      const outMark = dayMarks.find(m => m.action === 'Salida');

      entradaDisplay = inMark ? inMark.timeStr : '---';
      salidaDisplay = outMark ? outMark.timeStr : '---';
      breakDisplay = formatSecondsToHHMMSS(report.breakSeconds);
      workedDisplay = formatSecondsToHHMMSS(report.workedSeconds);

      if (report.tardiness) {
        const mins = Math.floor(report.tardinessSeconds / 60);
        tardinessDisplay = `<span style="color: var(--color-error); font-weight:600;">${mins} min</span>`;
        statusBadge = `<span class="table-status-badge Salida">Tardanza</span>`;
      } else {
        tardinessDisplay = isFlexible ? '---' : '0 min';
        statusBadge = `<span class="table-status-badge Ingreso">Asistió</span>`;
      }
      if (justification && justification.type === 'Permiso por Horas') {
        const compStr = justification.compensation === 'Sin goce' ? 'Sin goce' : 'Con goce';
        statusBadge = `<span class="table-status-badge Inicio-Refrigerio" style="background: rgba(30, 144, 255, 0.1); color: #1e90ff; border-color: rgba(30, 144, 255, 0.3);" title="Permiso de ${justification.startTime} a ${justification.endTime} (${compStr}) - ${justification.details}">Asistió (Permiso)</span>`;
      }
      if (isFlexible) {
        statusBadge = `<span class="table-status-badge Fin-Refrigerio">Asistió (Flex)</span>`;
      }
    } else {
      if (justification) {
        statusBadge = `<span class="table-status-badge Inicio-Refrigerio" title="${justification.details}">Justificado: ${justification.type}</span>`;
      } else if (isHoliday) {
        statusBadge = `<span class="table-status-badge Fin-Refrigerio">Feriado</span>`;
      } else if (isRestDay) {
        statusBadge = `<span class="table-status-badge" style="background: var(--surface-1); color: var(--text-secondary);">Descanso</span>`;
      } else {
        statusBadge = `<span class="table-status-badge Salida">Falta</span>`;
      }
    }

    const dayName = dObj.toLocaleDateString('es-ES', { weekday: 'long' });
    const capitalizedDay = dayName.charAt(0).toUpperCase() + dayName.slice(1);

    html += `
      <tr>
        <td>
          <div style="font-weight: 600;">${dateStr}</div>
          <div style="font-size: 0.75rem; color: var(--text-muted);">${capitalizedDay}</div>
        </td>
        <td class="text-center">${entradaDisplay}</td>
        <td class="text-center">${salidaDisplay}</td>
        <td class="text-center">${breakDisplay}</td>
        <td class="text-center" style="font-weight: 600;">${workedDisplay}</td>
        <td class="text-center">${tardinessDisplay}</td>
        <td class="text-center">${statusBadge}</td>
      </tr>
    `;
  }

  tbody.innerHTML = html;
}

// ==========================================
// SECURITY / DEVICE RESTRICTIONS
// ==========================================
let securityBlockMobile = false;
let securityRestrictPcs = false;
let securityRestrictMobiles = false;

function isMobileDevice() {
  const ua = (navigator.userAgent || navigator.vendor || window.opera || '').toLowerCase();
  
  // 1. Detección por User-Agent de celulares y tablets
  const isMobileUA = /mobile|android|iphone|ipad|ipod|tablet|blackberry|windows phone|opera mini|silk|kindle/i.test(ua);
  if (isMobileUA) return true;

  // 2. Detección por pantalla táctil + ancho de viewport pequeño o mediano
  const isTouch = ('ontouchstart' in window) || (navigator.maxTouchPoints > 0);
  const isSmallViewport = (window.innerWidth <= 900) || (window.screen.width <= 900);
  if (isTouch && isSmallViewport) return true;

  return false;
}

function isRestrictedMobileRole(role) {
  const roleLower = String(role || '').toLowerCase().trim();
  if (!roleLower) return true;

  // Cargos autorizados explícitamente en móviles (Administración, Supervisión, Jefatura, Gerencia, Dirección, Coordinación, Liderazgo)
  const isAuthorizedAdminRole = roleLower.includes('admin') || 
                                roleLower.includes('supervis') || 
                                roleLower.includes('jef') || 
                                roleLower.includes('geren') || 
                                roleLower.includes('direct') || 
                                roleLower.includes('coordinad') ||
                                roleLower.includes('lider') ||
                                roleLower.includes('líder') ||
                                roleLower.includes('encargad');

  if (isAuthorizedAdminRole) {
    return false; // NO restringido -> PERMITIDO en móvil
  }

  // Cargos operativos/ventas o no administrativos -> RESTRINGIDOS en móvil
  return true;
}

function lockBodyForSecurity(lock) {
  // Hace la pantalla de bloqueo verdaderamente inescapable
  document.body.style.overflow = lock ? 'hidden' : '';
  const appRoot = document.getElementById('app') || document.querySelector('.app-wrapper');
  if (appRoot) appRoot.style.pointerEvents = lock ? 'none' : '';
  const blockScreen = document.getElementById('security-block-screen');
  if (blockScreen) blockScreen.style.pointerEvents = lock ? 'all' : 'none';
}

function loadSecuritySettings() {
  securityBlockMobile = localStorage.getItem('security_block_mobile') === 'true';
  securityRestrictPcs = localStorage.getItem('security_restrict_pcs') === 'true';
  securityRestrictMobiles = localStorage.getItem('security_restrict_mobiles') === 'true';
  
  const chkMobile = document.getElementById('chk-block-mobile');
  const chkPcs = document.getElementById('chk-restrict-pcs');
  const chkRestrictMobiles = document.getElementById('chk-restrict-mobiles');

  if (chkRestrictMobiles) {
    chkRestrictMobiles.checked = securityRestrictMobiles;
    if (!chkRestrictMobiles.dataset.bound) {
      chkRestrictMobiles.dataset.bound = "true";
      chkRestrictMobiles.addEventListener('change', () => {
        securityRestrictMobiles = chkRestrictMobiles.checked;
        safeSetItem('security_restrict_mobiles', securityRestrictMobiles);
        if (securityRestrictMobiles && isMobileDevice()) {
          safeSetItem('asistencia_mobile_auth_token', ADMIN_PASSWORD_HASH);
        }

        if (googleScriptUrl) {
          fetch(getScriptUrlWithApiKey(), {
            method: 'POST',
            mode: 'no-cors',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              action: 'Guardar_Configuracion',
              apiKey: googleScriptApiKey,
              security_block_mobile: securityBlockMobile,
              security_restrict_pcs: securityRestrictPcs,
              security_restrict_mobiles: securityRestrictMobiles,
              tardiness_tolerance: tardinessTolerance,
              api_key: googleScriptApiKey
            })
          }).catch(err => console.error('Error sincronizando restricción de celulares:', err));
        }

        showToast(
          securityRestrictMobiles ? 'warning' : 'info',
          securityRestrictMobiles ? 'Restricción de Celulares Activada 🔒' : 'Restricción de Celulares Desactivada 🔓',
          securityRestrictMobiles ? 'Solo los celulares autorizados por el admin podrán acceder al sistema.' : 'Cualquier celular puede ingresar (según reglas de cargo DNI).'
        );

        validateDeviceSecurity();
      });
    }
  }

  if (chkMobile) {
    chkMobile.checked = securityBlockMobile;
    if (!chkMobile.dataset.bound) {
      chkMobile.dataset.bound = "true";
      chkMobile.addEventListener('change', () => {
        securityBlockMobile = chkMobile.checked;
        safeSetItem('security_block_mobile', securityBlockMobile);
        
        if (googleScriptUrl) {
          fetch(getScriptUrlWithApiKey(), {
            method: 'POST',
            mode: 'no-cors',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              action: 'Guardar_Configuracion',
              apiKey: googleScriptApiKey,
              security_block_mobile: securityBlockMobile,
              security_restrict_pcs: securityRestrictPcs,
              security_restrict_mobiles: securityRestrictMobiles,
              tardiness_tolerance: tardinessTolerance,
              api_key: googleScriptApiKey
            })
          }).catch(err => console.error('Error sincronizando bloqueo móvil:', err));
        }

        showToast(
          securityBlockMobile ? 'warning' : 'info',
          securityBlockMobile ? 'Bloqueo Móvil Activado 🔒' : 'Bloqueo Móvil Desactivado 🔓',
          securityBlockMobile ? 'El acceso desde celulares y tablets ha sido bloqueado en la nube.' : 'Los celulares y tablets ya pueden acceder al sistema.'
        );

        validateDeviceSecurity();
      });
    }
  }

  if (chkPcs) {
    chkPcs.checked = securityRestrictPcs;
    if (!chkPcs.dataset.bound) {
      chkPcs.dataset.bound = "true";
      chkPcs.addEventListener('change', () => {
        securityRestrictPcs = chkPcs.checked;
        safeSetItem('security_restrict_pcs', securityRestrictPcs);
        if (securityRestrictPcs) {
          const expectedToken = ADMIN_PASSWORD_HASH;
          safeSetItem('asistencia_pc_auth_token', expectedToken);
        }

        if (googleScriptUrl) {
          fetch(getScriptUrlWithApiKey(), {
            method: 'POST',
            mode: 'no-cors',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              action: 'Guardar_Configuracion',
              apiKey: googleScriptApiKey,
              security_block_mobile: securityBlockMobile,
              security_restrict_pcs: securityRestrictPcs,
              security_restrict_mobiles: securityRestrictMobiles,
              tardiness_tolerance: tardinessTolerance,
              api_key: googleScriptApiKey
            })
          }).catch(err => console.error('Error sincronizando restricción de PCs:', err));
        }

        showToast(
          securityRestrictPcs ? 'warning' : 'info',
          securityRestrictPcs ? 'Restricción de PCs Activada 🔒' : 'Restricción de PCs Desactivada 🔓',
          securityRestrictPcs ? 'Solo las computadoras autorizadas podrán marcar asistencia.' : 'Cualquier computadora puede marcar asistencia.'
        );

        validateDeviceSecurity();
      });
    }
  }
}

function validateDeviceSecurity() {
  const blockScreen = document.getElementById('security-block-screen');
  const blockTitle = document.getElementById('security-title');
  const blockMessage = document.getElementById('security-message');
  const blockIcon = document.getElementById('security-icon');
  const blockIconContainer = document.getElementById('security-icon-container');
  const authFormContainer = document.getElementById('security-auth-form-container');
  const btnShowAuth = document.getElementById('btn-security-show-auth');
  const btnCancelAuth = document.getElementById('btn-security-cancel-auth');
  
  if (!blockScreen) return false;

  // Case 0: Restricción de Celulares Autorizados por Token
  if (securityRestrictMobiles && isMobileDevice()) {
    const validMobileToken = ADMIN_PASSWORD_HASH;
    const storedMobileToken = localStorage.getItem('asistencia_mobile_auth_token');
    if (storedMobileToken !== validMobileToken) {
      blockTitle.textContent = "Celular No Autorizado 📱";
      blockMessage.innerHTML = "📱 Este teléfono móvil <strong>no cuenta con autorización</strong> para ingresar al sistema.<br><br>Pídale al administrador que autorice este celular ingresando la contraseña de administrador.";
      blockIcon.textContent = "phonelink_lock";
      if (blockIconContainer) {
        blockIconContainer.style.borderColor = "#f59e0b";
        blockIconContainer.style.background = "rgba(245, 158, 11, 0.1)";
      }
      blockIcon.style.color = "#f59e0b";
      if (btnShowAuth) {
        btnShowAuth.style.display = "inline-flex";
        btnShowAuth.querySelector('span:first-child').textContent = "Autorizar este Celular";
      }
      blockScreen.classList.remove('hidden');
      blockScreen.style.display = "flex";
      lockBodyForSecurity(true);
      return true;
    }
  }

  // Case 1: Bloqueo de Móviles y Tablets por Cargo Oficial
  // Solo se bloquea si hay una sesión activa de un cargo restringido (ej. Colaborador / Ventas)
  if (securityBlockMobile && isMobileDevice() && currentSession && currentSession.role) {
    if (isRestrictedMobileRole(currentSession.role)) {
      blockTitle.textContent = "Dispositivo No Autorizado";
      blockMessage.innerHTML = `🚫 Por motivos de seguridad, tu cargo (<strong>${currentSession.role}</strong>) no tiene permitido registrar asistencia desde celulares o tablets.<br><br>Por favor, utilice la computadora de escritorio fija de la oficina.`;
      blockIcon.textContent = "smartphone";
      if (blockIconContainer) {
        blockIconContainer.style.borderColor = "#ef4444";
        blockIconContainer.style.background = "rgba(239, 68, 68, 0.1)";
      }
      blockIcon.style.color = "#ef4444";
      if (btnShowAuth) btnShowAuth.style.display = "none";
      if (authFormContainer) authFormContainer.style.display = "none";
      blockScreen.classList.remove('hidden');
      blockScreen.style.display = "flex";
      lockBodyForSecurity(true);
      return true;
    }
  }

  // Case 2: Restricción de PCs autorizadas
  if (securityRestrictPcs && !isMobileDevice()) {
    // El token válido es el hash de la contraseña de admin
    const validToken = ADMIN_PASSWORD_HASH;
    const storedToken = localStorage.getItem('asistencia_pc_auth_token');
    if (storedToken !== validToken) {
      blockTitle.textContent = "Computadora No Registrada";
      blockMessage.innerHTML = "🖥️ Esta computadora <strong>no cuenta con autorización</strong> para registrar asistencia en este terminal.<br><br>Pídale al administrador que autorice este navegador ingresando la contraseña de administrador.";
      blockIcon.textContent = "desktop_access_disabled";
      if (blockIconContainer) {
        blockIconContainer.style.borderColor = "#f59e0b";
        blockIconContainer.style.background = "rgba(245, 158, 11, 0.1)";
      }
      blockIcon.style.color = "#f59e0b";
      if (btnShowAuth) {
        btnShowAuth.style.display = "inline-flex";
        btnShowAuth.querySelector('span:first-child').textContent = "Autorizar esta Computadora";
      }
      blockScreen.classList.remove('hidden');
      blockScreen.style.display = "flex";
      lockBodyForSecurity(true);
      return true;
    }
  }

  // Sin bloqueo activo: ocultar pantalla y desbloquear
  blockScreen.classList.add('hidden');
  blockScreen.style.display = "none";
  lockBodyForSecurity(false);
  return false;
}

function setupDeviceSecurityUIListeners() {
  const btnShowAuth = document.getElementById('btn-security-show-auth');
  const btnCancelAuth = document.getElementById('btn-security-cancel-auth');
  const authFormContainer = document.getElementById('security-auth-form-container');
  const btnSubmitAuth = document.getElementById('btn-submit-pc-authorization');
  const inputPass = document.getElementById('input-security-admin-pass');
  const errMsg = document.getElementById('security-admin-error-msg');
  
  const btnAuthorizePC = document.getElementById('btn-authorize-pc');
  const btnAuthorizeMobile = document.getElementById('btn-authorize-mobile');
  const btnRevokePCs = document.getElementById('btn-revoke-pcs');
  const btnRevokeMobiles = document.getElementById('btn-revoke-mobiles');
  
  if (btnShowAuth && authFormContainer) {
    btnShowAuth.addEventListener('click', () => {
      authFormContainer.style.display = 'block';
      authFormContainer.classList.remove('hidden');
      btnShowAuth.style.display = 'none';
      if (btnCancelAuth) {
        btnCancelAuth.style.display = 'inline-flex';
        btnCancelAuth.classList.remove('hidden');
      }
      if (inputPass) {
        inputPass.value = '';
        inputPass.focus();
      }
    });
  }
  
  if (btnCancelAuth && authFormContainer && btnShowAuth) {
    btnCancelAuth.addEventListener('click', () => {
      authFormContainer.style.display = 'none';
      authFormContainer.classList.add('hidden');
      btnShowAuth.style.display = 'inline-flex';
      btnCancelAuth.style.display = 'none';
      btnCancelAuth.classList.add('hidden');
      if (errMsg) {
        errMsg.style.display = 'none';
        errMsg.classList.add('hidden');
      }
    });
  }
  
  if (btnSubmitAuth && inputPass) {
    btnSubmitAuth.addEventListener('click', () => {
      const pass = inputPass.value;
      if (generateAuthToken(pass) === ADMIN_PASSWORD_HASH) {
        const token = ADMIN_PASSWORD_HASH;
        if (isMobileDevice()) {
          safeSetItem('asistencia_mobile_auth_token', token);
          showToast('success', 'Celular Autorizado ✅', 'Este dispositivo móvil ahora está autorizado para ingresar.');
        } else {
          safeSetItem('asistencia_pc_auth_token', token);
          showToast('success', 'Dispositivo Autorizado ✅', 'Esta computadora ahora está autorizada para registrar asistencia.');
        }
        if (errMsg) {
          errMsg.style.display = 'none';
          errMsg.classList.add('hidden');
        }
        validateDeviceSecurity();
      } else {
        if (errMsg) {
          errMsg.style.display = 'block';
          errMsg.classList.remove('hidden');
        }
      }
    });
    
    inputPass.addEventListener('keypress', (e) => {
      if (e.key === 'Enter') {
        btnSubmitAuth.click();
      }
    });
  }
  
  // Admin panel manual buttons
  if (btnAuthorizePC) {
    btnAuthorizePC.addEventListener('click', () => {
      const token = ADMIN_PASSWORD_HASH;
      safeSetItem('asistencia_pc_auth_token', token);
      showToast('success', 'Computadora Autorizada ✅', 'Este navegador ha sido autorizado manualmente.');
    });
  }

  if (btnAuthorizeMobile) {
    btnAuthorizeMobile.addEventListener('click', () => {
      const token = ADMIN_PASSWORD_HASH;
      safeSetItem('asistencia_mobile_auth_token', token);
      showToast('success', 'Celular Autorizado ✅', 'Este celular ha sido autorizado manualmente.');
    });
  }
  
  if (btnRevokePCs) {
    btnRevokePCs.addEventListener('click', async () => {
      const confirm = await showCustomConfirm({
        title: 'Revocar Accesos de PCs',
        message: '⚠️ ¿Estás seguro de que deseas desautorizar todas las computadoras?<br><br>Esta acción revocará la autorización de todos los navegadores PC.',
        type: 'danger',
        acceptText: 'Desautorizar PCs'
      });
      if (confirm) {
        localStorage.removeItem('asistencia_pc_auth_token');
        showToast('success', 'Accesos de PC Revocados', 'Todos los accesos locales de PC han sido removidos.');
        validateDeviceSecurity();
      }
    });
  }

  if (btnRevokeMobiles) {
    btnRevokeMobiles.addEventListener('click', async () => {
      const confirm = await showCustomConfirm({
        title: 'Revocar Celulares Autorizados',
        message: '⚠️ ¿Estás seguro de que deseas desautorizar todos los celulares?<br><br>Esta acción revocará el permiso de todos los dispositivos móviles y deberás volver a ingresar la contraseña de admin en cada teléfono.',
        type: 'danger',
        acceptText: 'Desautorizar Celulares'
      });
      if (confirm) {
        localStorage.removeItem('asistencia_mobile_auth_token');
        showToast('success', 'Celulares Desautorizados', 'Todos los permisos locales de teléfonos móviles han sido revocados.');
        validateDeviceSecurity();
      }
    });
  }
}


/* ==========================================================================
   VISTA GERENCIAL — KPIs, Gráficos y Tablas
   ========================================================================== */

let gerencialChartDaily  = null;
let gerencialChartAusentismo = null;
let gerencialChartWeekly = null;
let gerencialChartWeeklyTardiness = null;
let gerencialChartRanking = null;
let gerencialChartRankingTardanzas = null;
let gerencialChartAlerts = null;

function toLocalYMD(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function getGroupKey(dateStr, grouping) {
  const parts = dateStr.split('/');
  const dObj = new Date(parseInt(parts[2]), parseInt(parts[1]) - 1, parseInt(parts[0]));
  
  if (grouping === 'month') {
    const monthNames = ["Enero", "Febrero", "Marzo", "Abril", "Mayo", "Junio", "Julio", "Agosto", "Septiembre", "Octubre", "Noviembre", "Diciembre"];
    return monthNames[dObj.getMonth()];
  } else if (grouping === 'week') {
    const day = dObj.getDay() === 0 ? 6 : dObj.getDay() - 1; // lunes = 0
    const monday = new Date(dObj);
    monday.setDate(dObj.getDate() - day);
    const dd = String(monday.getDate()).padStart(2, '0');
    const mm = String(monday.getMonth() + 1).padStart(2, '0');
    return `Sem ${dd}/${mm}`;
  } else {
    const dd = parts[0];
    const mm = parts[1];
    return `${dd}/${mm}`;
  }
}

function setupGerencialListeners() {
  const selectPeriod = document.getElementById('ger-select-period');
  const selectGrouping = document.getElementById('ger-select-grouping');
  const btnRefresh   = document.getElementById('btn-ger-refresh');
  const startDateInput = document.getElementById('ger-start-date');
  const endDateInput = document.getElementById('ger-end-date');

  // Inicializar fechas con el mes actual si están vacías usando hora local
  if (startDateInput && endDateInput && (!startDateInput.value || !endDateInput.value)) {
    const today = new Date();
    const firstDay = new Date(today.getFullYear(), today.getMonth(), 1);
    startDateInput.value = toLocalYMD(firstDay);
    endDateInput.value = toLocalYMD(today);
  }

  if (selectPeriod) {
    selectPeriod.addEventListener('change', () => {
      const today = new Date();
      let start, end;

      if (selectPeriod.value === 'this_week') {
        const day = today.getDay() === 0 ? 6 : today.getDay() - 1; // lunes = 0
        start = new Date(today); start.setDate(today.getDate() - day);
        end   = new Date(today);
      } else if (selectPeriod.value === 'last_week') {
        const day = today.getDay() === 0 ? 6 : today.getDay() - 1;
        end   = new Date(today); end.setDate(today.getDate() - day - 1);
        start = new Date(end);   start.setDate(end.getDate() - 6);
      } else if (selectPeriod.value === 'this_month') {
        start = new Date(today.getFullYear(), today.getMonth(), 1);
        end   = new Date(today);
      } else if (selectPeriod.value === 'last_month') {
        start = new Date(today.getFullYear(), today.getMonth() - 1, 1);
        end   = new Date(today.getFullYear(), today.getMonth(), 0);
      }

      if (selectPeriod.value !== 'custom' && start && end) {
        startDateInput.value = toLocalYMD(start);
        endDateInput.value = toLocalYMD(end);
        loadGerencialReport();
      }
    });
  }

  if (selectGrouping) {
    selectGrouping.addEventListener('change', loadGerencialReport);
  }

  // Si cambia manualmente el input de fecha, cambiar periodo a "Personalizado"
  const onManualDateChange = () => {
    if (selectPeriod) selectPeriod.value = 'custom';
  };
  if (startDateInput) startDateInput.addEventListener('change', onManualDateChange);
  if (endDateInput) endDateInput.addEventListener('change', onManualDateChange);

  if (btnRefresh) {
    btnRefresh.addEventListener('click', loadGerencialReport);
  }

  // También recargar al cambiar colaborador
  const selectEmp = document.getElementById('ger-select-employee');
  if (selectEmp) {
    selectEmp.addEventListener('change', loadGerencialReport);
  }

  // Recargar al cambiar el tipo de horario
  const selectSchedType = document.getElementById('ger-select-schedule-type');
  if (selectSchedType) {
    selectSchedType.addEventListener('change', () => {
      const selectEmp = document.getElementById('ger-select-employee');
      if (selectEmp) selectEmp.value = 'all'; // Resetear a todos
      updateGerencialEmployeeSelect();
      loadGerencialReport();
    });
  }
}

function getGerencialDateRange() {
  const sv = document.getElementById('ger-start-date')?.value;
  const ev = document.getElementById('ger-end-date')?.value;
  const today = new Date();
  const start = sv ? new Date(sv + 'T00:00:00') : new Date(today.getFullYear(), today.getMonth(), 1);
  const end   = ev ? new Date(ev + 'T23:59:59') : new Date(today);
  return { start, end };
}

function isWorkDay(dateObj) {
  // Lunes(1) a Sábado(6) que no sean feriado
  const dow = dateObj.getDay();
  if (dow === 0) return false;
  const dd = String(dateObj.getDate()).padStart(2,'0');
  const mm = String(dateObj.getMonth()+1).padStart(2,'0');
  const yyyy = dateObj.getFullYear();
  const dayMonthStr = dd + '/' + mm;
  const fullStr = dd + '/' + mm + '/' + yyyy;
  const isGlobalHoliday = GLOBAL_FERIADOS.some(f => f === dayMonthStr);
  const isCustomHoliday = feriadosDatabase.some(f => normalizeDateStr(f.dateStr) === normalizeDateStr(fullStr));
  return !isGlobalHoliday && !isCustomHoliday;
}

function getWorkDaysInRange(start, end) {
  const days = [];
  const cur = new Date(start); cur.setHours(12,0,0,0);
  const endD = new Date(end);  endD.setHours(12,0,0,0);
  while (cur <= endD) {
    if (isWorkDay(cur)) {
      const dd = String(cur.getDate()).padStart(2,'0');
      const mm = String(cur.getMonth()+1).padStart(2,'0');
      const yyyy = cur.getFullYear();
      days.push(dd + '/' + mm + '/' + yyyy);
    }
    cur.setDate(cur.getDate() + 1);
    cur.setHours(12,0,0,0); // Evitar drifts por zona horaria en iteración
  }
  return days;
}

function updateGerencialEmployeeSelect() {
  const sel = document.getElementById('ger-select-employee');
  if (!sel) return;
  const schedType = document.getElementById('ger-select-schedule-type')?.value || 'fixed';
  const current = sel.value;
  sel.innerHTML = '<option value="all">Todos los colaboradores</option>';
  Object.keys(employeesDatabase)
    .filter(dni => {
      const emp = employeesDatabase[dni];
      if (!emp) return false;
      const isFlexible = (emp.weeklySchedule === 'flexible' || emp.workStart === '-' || emp.workStart === '—');
      if (schedType === 'fixed') return !isFlexible;
      if (schedType === 'flexible') return isFlexible;
      return true; // all
    })
    .sort((a,b) => employeesDatabase[a].name.localeCompare(employeesDatabase[b].name))
    .forEach(dni => {
      const opt = document.createElement('option');
      opt.value = dni;
      opt.textContent = employeesDatabase[dni].name;
      sel.appendChild(opt);
    });
  if (current && sel.querySelector(`option[value="${current}"]`)) sel.value = current;
}

function loadGerencialReport() {
  updateGerencialEmployeeSelect();
  const { start, end } = getGerencialDateRange();
  const filterDni = document.getElementById('ger-select-employee')?.value || 'all';

  // Historial normalizado
  cachedConsolidatedHistory = getAllCachedHistory();
  const allHistory = cachedConsolidatedHistory;
  const normalized = allHistory.map(item => {
    const nd = normalizeDateStr(item.dateStr);
    const nt = normalizeTimeStr(item.timeStr);
    return { ...item, dni: String(item.dni || '').trim(), dateStr: nd, timeStr: nt, timestamp: getTimestampFromDateAndTime(nd, nt) };
  }).filter(item => {
    if (!item.dni || !employeesDatabase[item.dni]) return false;
    if (filterDni !== 'all' && String(item.dni) !== String(filterDni)) return false;
    const d = new Date(item.timestamp || getTimestampFromDateAndTime(item.dateStr, item.timeStr));
    return d >= start && d <= end;
  });

  // Colaboradores en scope según tipo de horario seleccionado
  const schedType = document.getElementById('ger-select-schedule-type')?.value || 'fixed';
  const dnis = (filterDni === 'all' ? Object.keys(employeesDatabase) : [filterDni])
    .filter(dni => {
      const emp = employeesDatabase[dni];
      if (!emp) return false;
      const isFlexible = (emp.weeklySchedule === 'flexible' || emp.workStart === '-' || emp.workStart === '—');
      if (schedType === 'fixed') return !isFlexible;
      if (schedType === 'flexible') return isFlexible;
      return true; // all
    });
  const workDays = getWorkDaysInRange(start, end);

  // Generar todos los días del calendario en el rango para sumar horas/tardanzas
  const allCalendarDays = [];
  let curr = new Date(start);
  while (curr <= end) {
    const dd = String(curr.getDate()).padStart(2, '0');
    const mm = String(curr.getMonth() + 1).padStart(2, '0');
    const yyyy = curr.getFullYear();
    allCalendarDays.push(`${dd}/${mm}/${yyyy}`);
    const nextDate = new Date(curr);
    nextDate.setDate(nextDate.getDate() + 1);
    nextDate.setHours(12, 0, 0, 0);
    curr = nextDate;
  }

  // --- Calcular KPIs por colaborador ---
  const perEmployee = {};
  dnis.forEach(dni => {
    perEmployee[dni] = { attended: new Set(), late: 0, faltas: 0, workedSecs: 0, tardanzaSecs: 0 };
  });

  // Agrupar marcas por dni+fecha
  const marksByDniDate = {};
  normalized.forEach(item => {
    if (!perEmployee[item.dni]) return;
    const key = item.dni + '|' + item.dateStr;
    if (!marksByDniDate[key]) marksByDniDate[key] = [];
    marksByDniDate[key].push(item);
  });

  const todayYMD = toLocalYMD(new Date());

  // Por cada día del calendario y colaborador calcular asistencia, tardanza y horas
  allCalendarDays.forEach(dateStr => {
    const parts = dateStr.split('/');
    const dStrYMD = `${parts[2]}-${parts[1].padStart(2,'0')}-${parts[0].padStart(2,'0')}`;

    dnis.forEach(dni => {
      const emp = employeesDatabase[dni];
      const dObj = new Date(parseInt(parts[2]), parseInt(parts[1])-1, parseInt(parts[0]));
      const dow = String(dObj.getDay()); // 0=Dom...6=Sab

      // Determinar si es feriado
      let isHoliday = false;
      const dayMonth = `${parts[0].padStart(2, '0')}/${parts[1].padStart(2, '0')}`;
      if (GLOBAL_FERIADOS.includes(dayMonth)) {
        isHoliday = true;
      } else if (feriadosDatabase.some(f => normalizeDateStr(f.dateStr) === normalizeDateStr(dateStr))) {
        isHoliday = true;
      }

      // Determinar si según horario o fallback, este día está programado (debe trabajar)
      let scheduled = false;
      let daySchedObj = null;
      if (emp.weeklySchedule && emp.weeklySchedule !== 'flexible' && emp.weeklySchedule !== '') {
        try {
          let sched = emp.weeklySchedule;
          if (typeof sched === 'string') {
            sched = JSON.parse(sched);
          }
          const daySched = sched[dow];
          if (daySched && !daySched.isRestDay) {
            scheduled = true;
            daySchedObj = daySched;
          }
        } catch(e) {}
      } else {
        // Fallback: lunes a sábado no feriado es laborable
        if (dow !== '0' && !isHoliday) {
          scheduled = true;
        }
      }

      const key = dni + '|' + dateStr;
      const dayMarks = marksByDniDate[key] || [];
      const ingreso = dayMarks.find(m => m.action === 'Ingreso');

      if (ingreso) {
        if (scheduled) {
          perEmployee[dni].attended.add(dateStr);
        }
        const report = calculateWorkedTimesForDate(dayMarks, emp, dateStr);
        perEmployee[dni].workedSecs += report.workedSeconds;
        if (report.tardiness) {
          perEmployee[dni].late++;
          perEmployee[dni].tardanzaSecs += report.tardinessSeconds;
        }
      } else if (scheduled) {
        // Ausente en día programado — verificar si hoy ya terminó o es un día pasado
        let evaluateThisDay = false;
        if (dStrYMD < todayYMD) {
          evaluateThisDay = true;
        } else if (dStrYMD === todayYMD) {
          const now = new Date();
          const workEndStr = (daySchedObj && daySchedObj.workEnd) || emp.workEnd || '17:00';
          const [eh, em] = workEndStr.split(':').map(Number);
          if ((now.getHours() * 60 + now.getMinutes()) >= (eh * 60 + em)) {
            evaluateThisDay = true;
          }
        }

        if (evaluateThisDay) {
          // Si no tiene justificación, es falta
          const hasJust = justificacionesDatabase.some(j => String(j.dni) === String(dni) && normalizeDateStr(j.dateStr) === dateStr);
          if (!hasJust) {
            perEmployee[dni].faltas++;
          }
        }
      }
    });
  });

  // Totales globales
  let totalDiasEsperados = 0, totalDiasAsistidos = 0, totalTardanzas = 0, totalFaltas = 0, totalWorkedSecs = 0;
  let totalIngresos = 0;
  let totalTardanzaSecs = 0;
  
  dnis.forEach(dni => {
    const emp = employeesDatabase[dni];
    let diasEsp = 0;
    
    allCalendarDays.forEach(dateStr => {
      const parts = dateStr.split('/');
      const dStrYMD = `${parts[2]}-${parts[1].padStart(2,'0')}-${parts[0].padStart(2,'0')}`;
      const dObj = new Date(parseInt(parts[2]), parseInt(parts[1])-1, parseInt(parts[0]));
      const dow = String(dObj.getDay());

      let isHoliday = false;
      const dayMonth = `${parts[0].padStart(2, '0')}/${parts[1].padStart(2, '0')}`;
      if (GLOBAL_FERIADOS.includes(dayMonth)) {
        isHoliday = true;
      } else if (feriadosDatabase.some(f => normalizeDateStr(f.dateStr) === normalizeDateStr(dateStr))) {
        isHoliday = true;
      }

      let scheduled = false;
      let daySchedObj = null;
      if (emp.weeklySchedule && emp.weeklySchedule !== 'flexible' && emp.weeklySchedule !== '') {
        try {
          let sched = emp.weeklySchedule;
          if (typeof sched === 'string') {
            sched = JSON.parse(sched);
          }
          const daySched = sched[dow];
          if (daySched && !daySched.isRestDay) {
            scheduled = true;
            daySchedObj = daySched;
          }
        } catch(e) {}
      } else {
        if (dow !== '0' && !isHoliday) {
          scheduled = true;
        }
      }
      if (!scheduled) return;

      // Solo contar como día esperado si se evaluó (pasado o hoy marcado/terminado)
      let evaluateThisDay = false;
      if (dStrYMD < todayYMD) {
        evaluateThisDay = true;
      } else if (dStrYMD === todayYMD) {
        const key = dni + '|' + dateStr;
        const hasIngreso = (marksByDniDate[key] || []).some(m => m.action === 'Ingreso');
        if (hasIngreso) {
          evaluateThisDay = true;
        } else {
          const now = new Date();
          const workEndStr = (daySchedObj && daySchedObj.workEnd) || emp.workEnd || '17:00';
          const [eh, em] = workEndStr.split(':').map(Number);
          if ((now.getHours() * 60 + now.getMinutes()) >= (eh * 60 + em)) {
            evaluateThisDay = true;
          }
        }
      }

      if (evaluateThisDay) {
        diasEsp++;
      }
    });
    
    totalDiasEsperados += diasEsp;
    totalDiasAsistidos += perEmployee[dni].attended.size;
    totalTardanzas     += perEmployee[dni].late;
    totalFaltas        += perEmployee[dni].faltas;
    totalWorkedSecs    += perEmployee[dni].workedSecs;
    totalIngresos      += perEmployee[dni].attended.size;
    totalTardanzaSecs  += perEmployee[dni].tardanzaSecs;
  });

  const pctAsistencia  = totalDiasEsperados > 0 ? ((totalDiasAsistidos / totalDiasEsperados) * 100).toFixed(1) : 0;
  const pctAusentismo  = totalDiasEsperados > 0 ? ((totalFaltas / totalDiasEsperados) * 100).toFixed(1) : 0;
  const pctPuntualidad = totalIngresos > 0 ? (((totalIngresos - totalTardanzas) / totalIngresos) * 100).toFixed(1) : 0;

  // Formatear etiquetas según filtro de colaborador
  let finalHorasLabel = '';
  let finalTardanzasLabel = '';
  const horasTot = Math.floor(totalWorkedSecs / 3600);
  const minsTot  = Math.floor((totalWorkedSecs % 3600) / 60);

  if (filterDni === 'all') {
    finalHorasLabel = formatSecondsToHHMMSS(totalWorkedSecs);
    finalTardanzasLabel = totalTardanzaSecs > 0 ? formatSecondsToHHMMSS(totalTardanzaSecs) : '00:00:00';
  } else {
    finalHorasLabel = `${horasTot}h ${minsTot}m`;
    const tardanzasHoras = Math.floor(totalTardanzaSecs / 3600);
    const tardanzasMins  = Math.floor((totalTardanzaSecs % 3600) / 60);
    if (tardanzasHoras > 0) {
      finalTardanzasLabel = `${tardanzasHoras}h ${tardanzasMins}m`;
    } else {
      finalTardanzasLabel = `${tardanzasMins}m`;
    }
  }

  // Tardanzas promedio
  const avgTardanzaSecs = totalTardanzas > 0 ? (totalTardanzaSecs / totalTardanzas) : 0;
  const avgTardanzaMins = Math.round(avgTardanzaSecs / 60);
  const tardanzasSubLabel = totalTardanzas > 0 
    ? `promedio ${avgTardanzaMins}m en ${totalTardanzas} tardanzas`
    : `0 tardanzas registradas`;

  // --- Actualizar KPI Cards ---
  function setKpi(id, val, sub) {
    const el = document.getElementById('kpi-val-' + id);
    const subEl = document.getElementById('kpi-sub-' + id);
    if (el) el.textContent = val;
    if (subEl && sub) subEl.textContent = sub;
  }
  setKpi('asistencia',  pctAsistencia + '%',  totalDiasAsistidos + ' días presentes de ' + totalDiasEsperados + ' esperados');
  setKpi('ausentismo',  pctAusentismo + '%',  totalFaltas + ' faltas en el período');
  setKpi('puntualidad', pctPuntualidad + '%', (totalIngresos - totalTardanzas) + ' puntuales de ' + totalIngresos + ' ingresos');
  setKpi('horas',       finalHorasLabel,       'promedio ' + (dnis.length > 0 ? (horasTot / dnis.length).toFixed(1) : 0) + 'h/colaborador');
  setKpi('tardanzas',   finalTardanzasLabel,   tardanzasSubLabel);

  // --- Gráficos ---
  renderGerencialChartAusentismo(dnis, workDays, marksByDniDate, perEmployee);
  renderGerencialChartDaily(dnis, workDays, marksByDniDate, perEmployee);
  renderGerencialRankingPuntualidad(dnis, perEmployee);
  renderGerencialRankingTardanzas(dnis, perEmployee);
}

function renderGerencialChartAusentismo(dnis, workDays, marksByDniDate, perEmployee) {
  const ctx = document.getElementById('chart-daily-ausentismo');
  if (!ctx) return;
  if (gerencialChartAusentismo) { gerencialChartAusentismo.destroy(); gerencialChartAusentismo = null; }

  const grouping = document.getElementById('ger-select-grouping')?.value || 'day';
  const sourceDays = (grouping === 'day') ? workDays.slice(-30) : workDays;

  const labels = [];
  const dayToGroupMap = {};
  sourceDays.forEach(dateStr => {
    const key = getGroupKey(dateStr, grouping);
    if (!labels.includes(key)) {
      labels.push(key);
    }
    dayToGroupMap[dateStr] = key;
  });

  const groupFaltas = {};
  const groupProgramados = {};
  labels.forEach(k => {
    groupFaltas[k] = 0;
    groupProgramados[k] = 0;
  });

  sourceDays.forEach(dateStr => {
    const gKey = dayToGroupMap[dateStr];
    dnis.forEach(dni => {
      const emp = employeesDatabase[dni];
      const parts = dateStr.split('/');
      const dObj = new Date(parseInt(parts[2]), parseInt(parts[1])-1, parseInt(parts[0]));
      const dow = String(dObj.getDay());
      let scheduled = true;
      if (emp && emp.weeklySchedule && emp.weeklySchedule !== 'flexible' && emp.weeklySchedule !== '') {
        try {
          const sched = (typeof emp.weeklySchedule === 'string') ? JSON.parse(emp.weeklySchedule) : emp.weeklySchedule;
          const daySched = sched[dow];
          if (!daySched || daySched.isRestDay) scheduled = false;
        } catch(e) {}
      }
      if (!scheduled) return;

      groupProgramados[gKey]++;
      const key = dni + '|' + dateStr;
      const dayMarks = marksByDniDate[key] || [];
      const ingreso = dayMarks.find(m => m.action === 'Ingreso');
      if (!ingreso) {
        const hasJust = justificacionesDatabase.some(j => String(j.dni) === String(dni) && normalizeDateStr(j.dateStr) === dateStr);
        if (!hasJust) groupFaltas[gKey]++;
      }
    });
  });

  const faltasData = labels.map(k => groupFaltas[k]);
  const ausentismoData = labels.map(k => {
    const prog = groupProgramados[k];
    const falt = groupFaltas[k];
    return prog > 0 ? +((falt / prog) * 100).toFixed(1) : 0;
  });

  const isDark = document.body.classList.contains('dark') || document.documentElement.getAttribute('data-theme') === 'dark' || !document.body.classList.contains('light');
  const gridColor = isDark ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.06)';
  const textColor = isDark ? '#94a3b8' : '#64748b';

  gerencialChartAusentismo = new Chart(ctx, {
    type: 'bar',
    plugins: [ChartDataLabels],
    data: {
      labels: labels,
      datasets: [
        {
          label: 'Faltas',
          data: faltasData,
          type: 'line',
          borderColor: 'rgba(252, 165, 165, 0.9)',
          backgroundColor: 'rgba(252, 165, 165, 0.1)',
          tension: 0.3,
          fill: false,
          pointBackgroundColor: 'rgba(252, 165, 165, 0.9)',
          pointRadius: 3,
          pointHoverRadius: 5,
          borderWidth: 2,
          yAxisID: 'y',
          order: 1,
          datalabels: {
            anchor: 'end',
            align: 'top',
            color: 'rgba(252, 165, 165, 0.9)',
            font: { weight: 'bold', size: 10 },
            formatter: function(value) {
              return value > 0 ? value : '';
            }
          }
        },
        {
          label: '% Ausentismo',
          data: ausentismoData,
          type: 'bar',
          backgroundColor: '#dc2626',
          borderRadius: 4,
          barPercentage: 0.85,
          categoryPercentage: 0.9,
          yAxisID: 'y1',
          order: 2,
          datalabels: {
            anchor: 'center',
            align: 'center',
            backgroundColor: function(context) {
              const val = context.dataset.data[context.dataIndex];
              return val > 0 ? 'rgba(15, 23, 42, 0.65)' : 'transparent';
            },
            borderRadius: 3,
            padding: { top: 2, bottom: 2, left: 4, right: 4 },
            color: '#ffffff',
            font: { weight: 'bold', size: 9 },
            formatter: function(value) {
              return value > 0 ? value + '%' : '';
            }
          }
        }
      ]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      layout: {
        padding: {
          top: 15
        }
      },
      interaction: {
        mode: 'index',
        intersect: false
      },
      plugins: {
        legend: { labels: { color: textColor, font: { size: 11 }, boxWidth: 12 } },
        datalabels: {},
        tooltip: {
          callbacks: {
            label: function(context) {
              if (context.dataset.yAxisID === 'y1') {
                return ` ${context.dataset.label}: ${context.raw}%`;
              }
              return ` ${context.dataset.label}: ${context.raw}`;
            }
          }
        }
      },
      scales: {
        x: { ticks: { color: textColor, font: { size: 10 } }, grid: { color: gridColor } },
        y: {
          position: 'left',
          beginAtZero: true,
          max: (() => {
            const raw = Math.ceil(Math.max(...faltasData, 3) * 2);
            return raw % 2 === 0 ? raw : raw + 1;
          })(),
          ticks: { color: 'rgba(252, 165, 165, 0.9)', precision: 0, font: { size: 10 } },
          grid: { color: gridColor },
          title: { display: false }
        },
        y1: {
          position: 'right',
          beginAtZero: true,
          max: 120,
          ticks: { color: '#dc2626', callback: v => v + '%', font: { size: 10 } },
          grid: { drawOnChartArea: false },
          title: { display: false }
        }
      }
    }
  });
}

function renderGerencialChartDaily(dnis, workDays, marksByDniDate, perEmployee) {
  const ctx = document.getElementById('chart-daily-attendance');
  if (!ctx) return;
  if (gerencialChartDaily) { gerencialChartDaily.destroy(); gerencialChartDaily = null; }

  const grouping = document.getElementById('ger-select-grouping')?.value || 'day';
  const sourceDays = (grouping === 'day') ? workDays.slice(-30) : workDays;

  const labels = [];
  const dayToGroupMap = {};
  sourceDays.forEach(dateStr => {
    const key = getGroupKey(dateStr, grouping);
    if (!labels.includes(key)) {
      labels.push(key);
    }
    dayToGroupMap[dateStr] = key;
  });

  const groupIngresos = {};
  const groupPuntuales = {};
  labels.forEach(k => {
    groupIngresos[k] = 0;
    groupPuntuales[k] = 0;
  });

  const daysTracked = {};

  sourceDays.forEach(dateStr => {
    const gKey = dayToGroupMap[dateStr];
    if (!daysTracked[gKey]) daysTracked[gKey] = new Set();
    daysTracked[gKey].add(dateStr);

    dnis.forEach(dni => {
      const emp = employeesDatabase[dni];
      const parts = dateStr.split('/');
      const dObj = new Date(parseInt(parts[2]), parseInt(parts[1])-1, parseInt(parts[0]));
      const dow = String(dObj.getDay());
      let scheduled = true;
      if (emp && emp.weeklySchedule && emp.weeklySchedule !== 'flexible' && emp.weeklySchedule !== '') {
        try {
          const sched = (typeof emp.weeklySchedule === 'string') ? JSON.parse(emp.weeklySchedule) : emp.weeklySchedule;
          const daySched = sched[dow];
          if (!daySched || daySched.isRestDay) scheduled = false;
        } catch(e) {}
      }
      if (!scheduled) return;

      const key = dni + '|' + dateStr;
      const dayMarks = marksByDniDate[key] || [];
      const ingreso = dayMarks.find(m => m.action === 'Ingreso');
      if (ingreso) {
        groupIngresos[gKey]++;
        const report = calculateWorkedTimesForDate(dayMarks, emp, dateStr);
        if (!report.tardiness) groupPuntuales[gKey]++;
      }
    });
  });

  const puntualesData = labels.map(k => {
    const totalDays = daysTracked[k] ? daysTracked[k].size : 1;
    const avg = groupPuntuales[k] / totalDays;
    return Math.round(avg);
  });
  const puntualidadData = labels.map(k => {
    const ing = groupIngresos[k];
    const punt = groupPuntuales[k];
    return ing > 0 ? +((punt / ing) * 100).toFixed(1) : 0;
  });

  const isDark = document.body.classList.contains('dark') || document.documentElement.getAttribute('data-theme') === 'dark' || !document.body.classList.contains('light');
  const gridColor = isDark ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.06)';
  const textColor = isDark ? '#94a3b8' : '#64748b';

  gerencialChartDaily = new Chart(ctx, {
    type: 'bar',
    plugins: [ChartDataLabels],
    data: {
      labels: labels,
      datasets: [
        {
          label: 'Ingresos Puntuales',
          data: puntualesData,
          type: 'line',
          borderColor: 'rgba(147, 197, 253, 0.9)',
          backgroundColor: 'rgba(147, 197, 253, 0.1)',
          tension: 0.3,
          fill: false,
          pointBackgroundColor: 'rgba(147, 197, 253, 0.9)',
          pointRadius: 3,
          pointHoverRadius: 5,
          borderWidth: 2,
          yAxisID: 'y',
          order: 1,
          datalabels: {
            anchor: 'end',
            align: 'top',
            color: 'rgba(147, 197, 253, 0.9)',
            font: { weight: 'bold', size: 10 },
            formatter: function(value) {
              return value > 0 ? value : '';
            }
          }
        },
        {
          label: '% Puntualidad',
          data: puntualidadData,
          type: 'bar',
          backgroundColor: '#2563eb',
          borderRadius: 4,
          barPercentage: 0.85,
          categoryPercentage: 0.9,
          yAxisID: 'y1',
          order: 2,
          datalabels: {
            anchor: 'center',
            align: 'center',
            backgroundColor: function(context) {
              const val = context.dataset.data[context.dataIndex];
              return val > 0 ? 'rgba(15, 23, 42, 0.65)' : 'transparent';
            },
            borderRadius: 3,
            padding: { top: 2, bottom: 2, left: 4, right: 4 },
            color: '#ffffff',
            font: { weight: 'bold', size: 9 },
            formatter: function(value) {
              return value > 0 ? value + '%' : '';
            }
          }
        },
        {
          label: 'Meta (95%)',
          data: puntualidadData.map(() => 95),
          type: 'line',
          borderColor: 'rgba(34,197,94,0.6)',
          borderDash: [6,4],
          pointRadius: 0,
          borderWidth: 2,
          fill: false,
          yAxisID: 'y1',
          order: 0,
          datalabels: { display: false }
        }
      ]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      layout: {
        padding: {
          top: 15
        }
      },
      interaction: {
        mode: 'index',
        intersect: false
      },
      plugins: {
        legend: { labels: { color: textColor, font: { size: 11 }, boxWidth: 12 } },
        datalabels: {},
        tooltip: {
          callbacks: {
            label: function(context) {
              if (context.dataset.yAxisID === 'y1') {
                return ` ${context.dataset.label}: ${context.raw}%`;
              }
              return ` ${context.dataset.label}: ${context.raw}`;
            }
          }
        }
      },
      scales: {
        x: { ticks: { color: textColor, font: { size: 10 } }, grid: { color: gridColor } },
        y: {
          position: 'left',
          beginAtZero: true,
          max: (() => {
            const raw = Math.ceil(Math.max(...puntualesData, 3) * 2);
            return raw % 2 === 0 ? raw : raw + 1;
          })(),
          ticks: {
            color: 'rgba(147, 197, 253, 0.9)',
            precision: 0,
            stepSize: 2,
            font: { size: 10 }
          },
          grid: { color: gridColor },
          title: { display: false }
        },
        y1: {
          position: 'right',
          beginAtZero: true,
          max: 120,
          ticks: { color: '#2563eb', callback: v => v + '%', font: { size: 10 } },
          grid: { drawOnChartArea: false },
          title: { display: false }
        }
      }
    }
  });
}

function renderGerencialChartWeekly(dnis, start, end, marksByDniDate, perEmployee) {
  const ctx = document.getElementById('chart-weekly-trend');
  if (!ctx) return;
  if (gerencialChartWeekly) { gerencialChartWeekly.destroy(); gerencialChartWeekly = null; }

  // Agrupar por semana ISO
  const weekMap = {};
  const cur = new Date(start); cur.setHours(12,0,0,0);
  const endD = new Date(end);   endD.setHours(12,0,0,0);
  
  while (cur <= endD) {
    if (isWorkDay(cur)) {
      const dd = String(cur.getDate()).padStart(2,'0');
      const mm = String(cur.getMonth()+1).padStart(2,'0');
      const yyyy = cur.getFullYear();
      const dateStr = dd+'/'+mm+'/'+yyyy;
      // Semana: lunes de esa semana
      const dayOfWeek = cur.getDay() === 0 ? 6 : cur.getDay() - 1;
      const monday = new Date(cur); monday.setDate(cur.getDate() - dayOfWeek);
      const weekKey = String(monday.getDate()).padStart(2,'0') + '/' + String(monday.getMonth()+1).padStart(2,'0');
      if (!weekMap[weekKey]) weekMap[weekKey] = { dias: 0, faltas: 0, ingresos: 0, tardanzas: 0 };
      
      dnis.forEach(dni => {
        const emp = employeesDatabase[dni];
        const dow = String(cur.getDay());
        let scheduled = true;
        if (emp && emp.weeklySchedule && emp.weeklySchedule !== 'flexible' && emp.weeklySchedule !== '') {
          try {
            let sched = emp.weeklySchedule;
            if (typeof sched === 'string') {
              sched = JSON.parse(sched);
            }
            const daySched = sched[dow];
            if (!daySched || daySched.isRestDay) scheduled = false;
          } catch(e) {}
        }
        if (!scheduled) return; // Ignorar si no estaba programado

        weekMap[weekKey].dias++;
        const key = dni + '|' + dateStr;
        const dayMarks = marksByDniDate[key] || [];
        const ingreso = dayMarks.find(m => m.action === 'Ingreso');
        if (ingreso) {
          weekMap[weekKey].ingresos++;
          const report = calculateWorkedTimesForDate(dayMarks, emp, dateStr);
          if (report.tardiness) weekMap[weekKey].tardanzas++;
        } else {
          const hasJust = justificacionesDatabase.some(j => String(j.dni) === String(dni) && normalizeDateStr(j.dateStr) === dateStr);
          if (!hasJust) weekMap[weekKey].faltas++;
        }
      });
    }
    cur.setDate(cur.getDate() + 1);
    cur.setHours(12,0,0,0);
  }

  const weeks = Object.keys(weekMap).sort((a,b) => {
    const [da, ma] = a.split('/').map(Number);
    const [db, mb] = b.split('/').map(Number);
    if (ma !== mb) return ma - mb;
    return da - db;
  });
  const pcts = weeks.map(w => {
    const ing = weekMap[w].ingresos;
    const tard = weekMap[w].tardanzas;
    return ing > 0 ? +(((ing - tard) / ing) * 100).toFixed(1) : 100.0;
  });

  const isDark = document.body.classList.contains('dark') || !document.body.classList.contains('light');
  const gridColor = isDark ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.06)';
  const textColor = isDark ? '#94a3b8' : '#64748b';

  gerencialChartWeekly = new Chart(ctx, {
    type: 'line',
    plugins: [ChartDataLabels],
    data: {
      labels: weeks.map(w => 'Sem ' + w),
      datasets: [{
        label: '% Puntualidad',
        data: pcts,
        borderColor: '#a855f7',
        backgroundColor: 'rgba(168,85,247,0.1)',
        tension: 0.4,
        fill: true,
        pointBackgroundColor: '#a855f7',
        pointRadius: 5
      }, {
        label: 'Meta (95%)',
        data: weeks.map(() => 95),
        borderColor: 'rgba(34,197,94,0.6)',
        borderDash: [6,4],
        pointRadius: 0,
        fill: false
      }]
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      plugins: {
        legend: { labels: { color: textColor, font: { size: 11 }, boxWidth: 12 } },
        datalabels: {
          display: false
        }
      },
      scales: {
        x: { ticks: { color: textColor, font: { size: 10 } }, grid: { color: gridColor } },
        y: { beginAtZero: true, ticks: { color: textColor, callback: v => v + '%' }, grid: { color: gridColor } }
      }
    }
  });
}

function renderGerencialChartWeeklyTardiness(dnis, start, end, marksByDniDate) {
  const ctx = document.getElementById('chart-weekly-tardiness');
  if (!ctx) return;
  if (gerencialChartWeeklyTardiness) { gerencialChartWeeklyTardiness.destroy(); gerencialChartWeeklyTardiness = null; }

  const weekMap = {};
  const weeksList = [];
  const cur = new Date(start); cur.setHours(12,0,0,0);
  const endD = new Date(end);   endD.setHours(12,0,0,0);
  
  while (cur <= endD) {
    if (isWorkDay(cur)) {
      const dd = String(cur.getDate()).padStart(2,'0');
      const mm = String(cur.getMonth()+1).padStart(2,'0');
      const yyyy = cur.getFullYear();
      const dateStr = dd+'/'+mm+'/'+yyyy;
      
      const dayOfWeek = cur.getDay() === 0 ? 6 : cur.getDay() - 1;
      const monday = new Date(cur); monday.setDate(cur.getDate() - dayOfWeek);
      const weekKey = String(monday.getDate()).padStart(2,'0') + '/' + String(monday.getMonth()+1).padStart(2,'0');
      
      if (!weekMap[weekKey]) {
        weekMap[weekKey] = {};
        weeksList.push(weekKey);
      }
      
      dnis.forEach(dni => {
        if (!weekMap[weekKey][dni]) {
          weekMap[weekKey][dni] = { count: 0, seconds: 0 };
        }
        const emp = employeesDatabase[dni];
        const key = dni + '|' + dateStr;
        const dayMarks = marksByDniDate[key] || [];
        const ingreso = dayMarks.find(m => m.action === 'Ingreso');
        
        if (ingreso) {
          let scheduled = false;
          const dow = String(cur.getDay());
          if (emp.weeklySchedule && emp.weeklySchedule !== 'flexible' && emp.weeklySchedule !== '') {
            try {
              let sched = emp.weeklySchedule;
              if (typeof sched === 'string') sched = JSON.parse(sched);
              const daySched = sched[dow];
              if (daySched && !daySched.isRestDay) scheduled = true;
            } catch(e) {}
          } else {
            if (dow !== '0') scheduled = true;
          }
          
          if (scheduled) {
            const report = calculateWorkedTimesForDate(dayMarks, emp, dateStr);
            if (report.tardiness) {
              weekMap[weekKey][dni].count++;
              weekMap[weekKey][dni].seconds += report.tardinessSeconds;
            }
          }
        }
      });
    }
    cur.setDate(cur.getDate() + 1);
    cur.setHours(12,0,0,0);
  }

  const sortedWeeks = weeksList.filter((v, i, a) => a.indexOf(v) === i).sort((a,b) => {
    const [da, ma] = a.split('/').map(Number);
    const [db, mb] = b.split('/').map(Number);
    if (ma !== mb) return ma - mb;
    return da - db;
  });

  const colorsList = [
    'rgba(249, 115, 22, 0.75)',  // orange
    'rgba(168, 85, 247, 0.75)',  // purple
    'rgba(59, 130, 246, 0.75)',  // blue
    'rgba(236, 72, 153, 0.75)',  // pink
    'rgba(20, 184, 166, 0.75)',  // teal
    'rgba(234, 179, 8, 0.75)',   // yellow
    'rgba(99, 102, 241, 0.75)',  // indigo
    'rgba(244, 63, 94, 0.75)',   // rose
  ];

  const datasets = dnis.map((dni, index) => {
    const emp = employeesDatabase[dni];
    const dataCount = [];
    const dataSeconds = [];
    
    sortedWeeks.forEach(w => {
      const stats = weekMap[w][dni] || { count: 0, seconds: 0 };
      dataCount.push(stats.count);
      dataSeconds.push(stats.seconds);
    });

    const color = colorsList[index % colorsList.length];
    
    return {
      label: emp.name,
      data: dataCount,
      tardinessSeconds: dataSeconds,
      backgroundColor: color,
      borderRadius: 4,
      stack: 'tardinessStack'
    };
  }).filter(ds => ds.data.some(c => c > 0));

  const isDark = document.body.classList.contains('dark') || document.documentElement.getAttribute('data-theme') === 'dark' || !document.body.classList.contains('light');
  const gridColor = isDark ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.06)';
  const textColor = isDark ? '#94a3b8' : '#64748b';

  gerencialChartWeeklyTardiness = new Chart(ctx, {
    type: 'bar',
    plugins: [ChartDataLabels],
    data: {
      labels: sortedWeeks.map(w => 'Sem ' + w),
      datasets: datasets
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { display: false },
        datalabels: {
          color: '#ffffff',
          font: { weight: 'bold', size: 10 },
          formatter: function(value) {
            return value > 0 ? value : '';
          }
        },
        tooltip: {
          callbacks: {
            label: function(context) {
              const datasetLabel = context.dataset.label || '';
              const count = context.raw;
              const seconds = context.dataset.tardinessSeconds[context.dataIndex];
              const hh = Math.floor(seconds / 3600);
              const mm = Math.round((seconds % 3600) / 60);
              const timeStr = `${hh}h ${mm}m`;
              return ` ${datasetLabel}: ${count} tardanzas (${timeStr})`;
            }
          }
        }
      },
      scales: {
        x: { stacked: true, ticks: { color: textColor, font: { size: 10 } }, grid: { color: gridColor } },
        y: { stacked: true, beginAtZero: true, ticks: { color: textColor, precision: 0 }, grid: { color: gridColor } }
      }
    }
  });
}

function renderGerencialRankingPuntualidad(dnis, perEmployee) {
  const ctx = document.getElementById('chart-ranking-puntualidad');
  if (!ctx) return;
  if (gerencialChartRanking) { gerencialChartRanking.destroy(); gerencialChartRanking = null; }

  const rows = dnis.map(dni => {
    const emp = employeesDatabase[dni];
    const asistidos = perEmployee[dni].attended.size;
    const tardanzas = perEmployee[dni].late;
    const pct = asistidos > 0 ? +(((asistidos - tardanzas) / asistidos) * 100).toFixed(1) : 0;
    return { name: emp.name, pct };
  }).sort((a,b) => b.pct - a.pct);

  const isDark = document.body.classList.contains('dark') || document.documentElement.getAttribute('data-theme') === 'dark' || !document.body.classList.contains('light');
  const gridColor = isDark ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.06)';
  const textColor = isDark ? '#94a3b8' : '#64748b';

  gerencialChartRanking = new Chart(ctx, {
    type: 'bar',
    plugins: [ChartDataLabels],
    data: {
      labels: rows.map(r => r.name),
      datasets: [{
        label: '% Puntualidad',
        data: rows.map(r => r.pct),
        backgroundColor: 'rgba(59, 130, 246, 0.8)',
        borderRadius: 4
      }]
    },
    options: {
      indexAxis: 'y',
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { display: false },
        tooltip: {
          callbacks: {
            label: function(context) {
              return ` ${context.raw}%`;
            }
          }
        },
        datalabels: {
          anchor: 'end',
          align: 'end',
          color: textColor,
          font: { weight: 'bold', size: 11 },
          formatter: function(value) {
            return value + '%';
          }
        }
      },
      scales: {
        x: {
          beginAtZero: true,
          max: 100,
          ticks: { color: textColor, callback: v => v + '%' },
          grid: { color: gridColor }
        },
        y: { ticks: { color: textColor, font: { size: 10 } }, grid: { display: false } }
      }
    }
  });
}

function renderGerencialRankingTardanzas(dnis, perEmployee) {
  const ctx = document.getElementById('chart-ranking-tardanzas');
  if (!ctx) return;
  if (gerencialChartRankingTardanzas) { gerencialChartRankingTardanzas.destroy(); gerencialChartRankingTardanzas = null; }

  const rows = dnis.map(dni => {
    const emp = employeesDatabase[dni];
    const tardSecs = perEmployee[dni].tardanzaSecs || 0;
    const tardCount = perEmployee[dni].late || 0;
    const hh = Math.floor(tardSecs / 3600);
    const mm = Math.floor((tardSecs % 3600) / 60);
    const ss = tardSecs % 60;
    const timeLabel = `${hh}:${String(mm).padStart(2,'0')}:${String(ss).padStart(2,'0')}`;
    return { name: emp.name, tardSecs, tardCount, timeLabel };
  }).sort((a,b) => b.tardSecs - a.tardSecs);

  const isDark = document.body.classList.contains('dark') || document.documentElement.getAttribute('data-theme') === 'dark' || !document.body.classList.contains('light');
  const gridColor = isDark ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.06)';
  const textColor = isDark ? '#94a3b8' : '#64748b';

  gerencialChartRankingTardanzas = new Chart(ctx, {
    type: 'bar',
    plugins: [ChartDataLabels],
    data: {
      labels: rows.map(r => r.name),
      datasets: [{
        label: 'Tardanzas',
        data: rows.map(r => r.tardSecs),
        timeLabels: rows.map(r => r.timeLabel),
        tardCounts: rows.map(r => r.tardCount),
        backgroundColor: 'rgba(248, 113, 113, 0.8)',
        borderRadius: 4
      }]
    },
    options: {
      indexAxis: 'y',
      responsive: true,
      maintainAspectRatio: false,
      layout: {
        padding: {
          right: 55
        }
      },
      plugins: {
        legend: { display: false },
        tooltip: {
          callbacks: {
            label: function(context) {
              const tl = context.dataset.timeLabels[context.dataIndex];
              const cnt = context.dataset.tardCounts[context.dataIndex];
              return ` ${tl} (${cnt} tardanzas)`;
            }
          }
        },
        datalabels: {
          anchor: 'end',
          align: 'end',
          color: textColor,
          font: { weight: 'bold', size: 11 },
          formatter: function(value, context) {
            const label = context.dataset.timeLabels[context.dataIndex];
            return value > 0 ? label : '';
          }
        }
      },
      scales: {
        x: {
          beginAtZero: true,
          ticks: {
            color: textColor,
            callback: function(value) {
              const hh = Math.floor(value / 3600);
              const mm = Math.floor((value % 3600) / 60);
              return `${hh}:${String(mm).padStart(2,'0')}`;
            }
          },
          grid: { color: gridColor }
        },
        y: { ticks: { color: textColor, font: { size: 10 } }, grid: { display: false } }
      }
    }
  });
}

function renderGerencialAlerts(dnis, perEmployee) {
  // Removido a solicitud del usuario
}

function updateCloudStatus(status) {
  const indicator = document.getElementById('cloud-status-indicator');
  if (!indicator) return;
  const dot = indicator.querySelector('.status-dot');
  const txt = indicator.querySelector('.status-text');
  if (!dot || !txt) return;

  dot.style.animation = '';

  if (status === 'syncing') {
    indicator.style.background = 'rgba(234, 179, 8, 0.15)';
    indicator.style.color = '#eab308';
    indicator.style.borderColor = 'rgba(234, 179, 8, 0.25)';
    dot.style.background = '#eab308';
    dot.style.boxShadow = '0 0 6px #eab308';
    dot.style.animation = 'pulse-active 1.5s infinite alternate';
    txt.textContent = 'Sincronizando...';
  } else if (status === 'connected') {
    indicator.style.background = 'rgba(34, 197, 94, 0.15)';
    indicator.style.color = '#22c55e';
    indicator.style.borderColor = 'rgba(34, 197, 94, 0.25)';
    dot.style.background = '#22c55e';
    dot.style.boxShadow = '0 0 6px #22c55e';
    txt.textContent = 'Conectado';
  } else if (status === 'error') {
    indicator.style.background = 'rgba(239, 68, 68, 0.15)';
    indicator.style.color = '#ef4444';
    indicator.style.borderColor = 'rgba(239, 68, 68, 0.25)';
    dot.style.background = '#ef4444';
    dot.style.boxShadow = '0 0 6px #ef4444';
    txt.textContent = 'Error de conexión';
  }
}

/* ==========================================================================
   PESTAÑA VALIDACIONES Y SANCIONES - MOTOR DE CONTROL Y REGLAS DE NEGOCIO
   ========================================================================== */

let cachedValidationDataMap = {};

function formatDateToInputISO(dateObj) {
  if (!(dateObj instanceof Date) || isNaN(dateObj.getTime())) return '';
  const y = dateObj.getFullYear();
  const m = String(dateObj.getMonth() + 1).padStart(2, '0');
  const d = String(dateObj.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function updateValidationEmployeeSelectOptions() {
  const select = document.getElementById('val-select-employee');
  if (!select) return;
  const currentVal = select.value || 'all';

  let html = `<option value="all" ${currentVal === 'all' ? 'selected' : ''}>Todos los Agentes</option>`;
  const staffKeys = Object.keys(employeesDatabase);

  staffKeys.sort((a, b) => (employeesDatabase[a]?.name || '').localeCompare(employeesDatabase[b]?.name || '')).forEach(key => {
    const emp = employeesDatabase[key];
    if (!isEmployeeActive(emp)) return;
    const cleanD = String(emp.dni || key).replace(/'/g, '').trim();
    const isSel = (currentVal === cleanD) ? 'selected' : '';
    html += `<option value="${cleanD}" ${isSel}>${escapeHtml(emp.name)} (${cleanD})</option>`;
  });

  select.innerHTML = html;
}

function setupValidationsListeners() {
  const statusSelect = document.getElementById('val-select-status');
  const empSelect = document.getElementById('val-select-employee');
  const schedTypeSelect = document.getElementById('val-select-schedule-type');
  const startDateInput = document.getElementById('val-input-start-date');
  const endDateInput = document.getElementById('val-input-end-date');
  const quickMonthBtn = document.getElementById('btn-val-quick-month');
  const quick6mBtn = document.getElementById('btn-val-quick-6m');
  const exportBtn = document.getElementById('btn-export-validations');
  const modalCloseBtn = document.getElementById('btn-val-modal-close');

  const now = new Date();
  if (endDateInput && !endDateInput.value) {
    endDateInput.value = formatDateToInputISO(now);
  }
  if (startDateInput && !startDateInput.value) {
    const d6 = new Date(now);
    d6.setMonth(d6.getMonth() - 6);
    startDateInput.value = formatDateToInputISO(d6);
  }

  const triggerFilter = () => {
    if (typeof renderValidationsView === 'function') renderValidationsView();
  };

  if (statusSelect) statusSelect.addEventListener('change', triggerFilter);
  if (empSelect) empSelect.addEventListener('change', triggerFilter);
  if (schedTypeSelect) schedTypeSelect.addEventListener('change', triggerFilter);
  if (startDateInput) startDateInput.addEventListener('change', triggerFilter);
  if (endDateInput) endDateInput.addEventListener('change', triggerFilter);

  if (quickMonthBtn) {
    quickMonthBtn.addEventListener('click', () => {
      const d = new Date();
      if (endDateInput) endDateInput.value = formatDateToInputISO(d);
      const d1 = new Date(d.getFullYear(), d.getMonth(), 1);
      if (startDateInput) startDateInput.value = formatDateToInputISO(d1);
      triggerFilter();
    });
  }

  if (quick6mBtn) {
    quick6mBtn.addEventListener('click', () => {
      const d = new Date();
      if (endDateInput) endDateInput.value = formatDateToInputISO(d);
      d.setMonth(d.getMonth() - 6);
      if (startDateInput) startDateInput.value = formatDateToInputISO(d);
      triggerFilter();
    });
  }

  if (exportBtn) {
    exportBtn.addEventListener('click', exportValidationsReportExcel);
  }

  if (modalCloseBtn) {
    modalCloseBtn.addEventListener('click', () => {
      const modal = document.getElementById('modal-validation-details');
      if (modal) modal.classList.add('hidden');
    });
  }

  const btnOpenRules = document.getElementById('btn-open-rules-modal');
  const btnCloseRules = document.getElementById('btn-val-rules-modal-close');

  if (btnOpenRules) {
    btnOpenRules.addEventListener('click', () => {
      const modal = document.getElementById('modal-validation-rules');
      if (modal) modal.classList.remove('hidden');
    });
  }

  if (btnCloseRules) {
    btnCloseRules.addEventListener('click', () => {
      const modal = document.getElementById('modal-validation-rules');
      if (modal) modal.classList.add('hidden');
    });
  }
}

function getWeekOfYear(dateObj) {
  if (!dateObj || isNaN(dateObj.getTime())) return 1;
  const d = new Date(Date.UTC(dateObj.getFullYear(), dateObj.getMonth(), dateObj.getDate()));
  const dayNum = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  return Math.ceil((((d - yearStart) / 86400000) + 1) / 7);
}



function isEmployeeFlexibleSchedule(emp) {
  if (!emp) return false;
  
  const roleStr = String(emp.role || emp.cargo || emp.puesto || '').toLowerCase().trim();
  if (roleStr.includes('gerencia') || roleStr.includes('gerente') || roleStr.includes('director') || roleStr.includes('jefe de operaciones')) {
    return true;
  }

  const workStartStr = String(emp.workStart || '').trim();
  if (workStartStr === '—' || workStartStr === '-' || workStartStr === '' || workStartStr === 'null' || workStartStr === 'undefined') {
    return true;
  }

  if (emp.weeklySchedule === 'flexible' || emp.scheduleType === 'flexible' || emp.scheduleType === 'flex') {
    return true;
  }

  if (typeof emp.weeklySchedule === 'string') {
    try {
      const parsed = JSON.parse(emp.weeklySchedule);
      if (parsed === 'flexible') return true;
    } catch(e) {}
  }

  return false;
}

function renderValidationsView() {
  updateValidationEmployeeSelectOptions();

  const statusVal = document.getElementById('val-select-status')?.value || 'all';
  const empVal = document.getElementById('val-select-employee')?.value || 'all';
  const schedTypeVal = document.getElementById('val-select-schedule-type')?.value || 'all';
  const startDateVal = document.getElementById('val-input-start-date')?.value || '';
  const endDateVal = document.getElementById('val-input-end-date')?.value || '';

  const allHistory = getAllCachedHistory();

  let now = new Date();
  
  let dEnd = now;
  if (endDateVal) {
    const parts = endDateVal.split('-');
    if (parts.length === 3) {
      dEnd = new Date(parseInt(parts[0], 10), parseInt(parts[1], 10) - 1, parseInt(parts[2], 10), 23, 59, 59);
    }
  }
  if (isNaN(dEnd.getTime())) dEnd = now;

  let dStart = new Date(now.getFullYear(), now.getMonth(), 1, 0, 0, 0);
  if (startDateVal) {
    const parts = startDateVal.split('-');
    if (parts.length === 3) {
      dStart = new Date(parseInt(parts[0], 10), parseInt(parts[1], 10) - 1, parseInt(parts[2], 10), 0, 0, 0);
    }
  }
  if (isNaN(dStart.getTime())) dStart = new Date(now.getFullYear(), now.getMonth(), 1, 0, 0, 0);

  const july12026 = new Date(2026, 6, 1, 0, 0, 0);
  let dStart6m = new Date(now);
  dStart6m.setMonth(dStart6m.getMonth() - 6);
  if (dStart6m < july12026) {
    dStart6m = july12026;
  }

  const staffKeys = Object.keys(employeesDatabase);
  cachedValidationDataMap = {};

  let countTotal = 0;
  let countBaja = 0;
  let countRetiro = 0;
  let countExceso = 0;

  const resultRows = [];

  staffKeys.forEach(dni => {
    const emp = employeesDatabase[dni];
    if (!emp) return;
    if (!isEmployeeActive(emp)) return;

    const cleanDni = String(emp.dni || dni).replace(/'/g, '').trim();
    const cleanEmpVal = String(empVal || '').replace(/'/g, '').trim();

    if (cleanEmpVal !== 'all' && cleanDni !== cleanEmpVal) {
      return;
    }

    let isFlex = isEmployeeFlexibleSchedule(emp);
    let schedStr = isFlex ? 'Flexible' : 'Fijo';

    if (schedTypeVal === 'fijo' && isFlex) return;
    if (schedTypeVal === 'flexible' && !isFlex) return;

    const empMarks = allHistory.filter(h => String(h.dni || '').replace(/'/g, '').trim() === cleanDni);
    
    const datesMap = {};
    empMarks.forEach(m => {
      const normD = normalizeDateStr(m.dateStr);
      if (!datesMap[normD]) datesMap[normD] = [];
      datesMap[normD].push(m);
    });

    let totalTardanzasRango = 0;
    let weeklyTardanzasMap = {};
    let totalFaltasMes = 0;
    let consecutiveAbsences = 0;
    let maxConsecutiveAbsences = 0;
    let tardinessAuditList = [];
    let absenceAuditList = [];

    const dayNames = ['Domingo', 'Lunes', 'Martes', 'Miércoles', 'Jueves', 'Viernes', 'Sábado'];

    let curr = new Date(dStart);
    while (curr <= dEnd && curr <= now) {
      const dateStr = getTodayNormalizedDateStr(curr);
      const dayOfWeek = curr.getDay();

      const justification = justificacionesDatabase.find(j => 
        String(j.dni || '').replace(/'/g, '').trim() === cleanDni && 
        normalizeDateStr(j.dateStr) === dateStr
      );

      const dStr = String(curr.getDate()).padStart(2, '0');
      const mStr = String(curr.getMonth() + 1).padStart(2, '0');
      const dayMonth = `${dStr}/${mStr}`;
      const isStaticHoliday = GLOBAL_FERIADOS.includes(dayMonth);
      const customHoliday = feriadosDatabase.find(f => normalizeDateStr(f.dateStr) === dateStr);
      const isHoliday = isStaticHoliday || !!customHoliday;

      let daySched = null;
      let schedObj = emp.weeklySchedule;
      if (typeof schedObj === 'string' && schedObj.trim() !== '') {
        try { schedObj = JSON.parse(schedObj); } catch(e) { schedObj = null; }
      }
      if (schedObj && schedObj[dayOfWeek]) {
        daySched = schedObj[dayOfWeek];
      }
      if (!daySched) {
        if (dayOfWeek === 0) daySched = { isRestDay: true };
        else daySched = { isRestDay: false };
      }
      const isRestDay = !!daySched.isRestDay;

      const marks = datesMap[dateStr] || [];
      const hasIngreso = marks.some(m => m.action === 'Ingreso');

      if (!hasIngreso) {
        if (!justification && !isRestDay && !isHoliday && !isFlex) {
          totalFaltasMes++;
          consecutiveAbsences++;
          if (consecutiveAbsences > maxConsecutiveAbsences) {
            maxConsecutiveAbsences = consecutiveAbsences;
          }
          absenceAuditList.push({
            dateStr: dateStr,
            dayName: dayNames[dayOfWeek] || '',
            detalle: 'Sin marcado de ingreso registrado ni justificación',
            dictamen: 'Falta Injustificada'
          });
        } else {
          consecutiveAbsences = 0;
        }
      } else {
        consecutiveAbsences = 0;
        const report = calculateWorkedTimesForDate(marks, emp, dateStr);
        const entradaRealStr = report ? (report.entradaReal || report.firstIngresoTimeStr) : null;

        if (report && entradaRealStr && entradaRealStr !== '---' && !isFlex && !isRestDay && !isHoliday) {
          const entrySecs = timeStrToSeconds(entradaRealStr);
          const workStartStr = daySched.workStart || emp.workStart || "08:00";
          const workStartSecs = timeStrToSeconds(workStartStr);
          const minsLate = Math.max(0, Math.floor((entrySecs - workStartSecs) / 60));

          if (minsLate > 0) {
            const wNum = getWeekOfYear(curr);
            const weekKey = `${curr.getFullYear()}-W${wNum}`;

            if (!weeklyTardanzasMap[weekKey]) {
              weeklyTardanzasMap[weekKey] = {
                toleranceUsedDays: 0,
                totalLateDays: 0,
                exceededQuota: false
              };
            }

            weeklyTardanzasMap[weekKey].totalLateDays++;

            let dictamen = '';
            let statusTag = '';
            let isTardanzaEfectiva = false;

            const tolThreshold = (typeof tardinessTolerance === 'number' && tardinessTolerance > 0) ? tardinessTolerance : 10;
            if (minsLate > tolThreshold) {
              dictamen = `Exceso >${tolThreshold}m (${minsLate} min)`;
              statusTag = 'exceeded';
              isTardanzaEfectiva = true;
            } else {
              weeklyTardanzasMap[weekKey].toleranceUsedDays++;
              if (weeklyTardanzasMap[weekKey].toleranceUsedDays <= 2) {
                dictamen = `Tolerancia (${minsLate}m - Día ${weeklyTardanzasMap[weekKey].toleranceUsedDays}/2)`;
                statusTag = 'tolerated';
                isTardanzaEfectiva = false;
              } else {
                dictamen = `Excede Cuota Semanal (${minsLate}m - Día ${weeklyTardanzasMap[weekKey].toleranceUsedDays} de tol.)`;
                statusTag = 'quota_exceeded';
                isTardanzaEfectiva = true;
                weeklyTardanzasMap[weekKey].exceededQuota = true;
              }
            }

            if (isTardanzaEfectiva) {
              totalTardanzasRango++;
            }

            const dayOfWeekCurr = curr.getDay();
            const mondayOffset = dayOfWeekCurr === 0 ? -6 : 1 - dayOfWeekCurr;
            const sundayOffset = dayOfWeekCurr === 0 ? 0 : 7 - dayOfWeekCurr;
            
            const mondayDate = new Date(curr);
            mondayDate.setDate(curr.getDate() + mondayOffset);
            const sundayDate = new Date(curr);
            sundayDate.setDate(curr.getDate() + sundayOffset);

            const mD = String(mondayDate.getDate()).padStart(2, '0');
            const mM = String(mondayDate.getMonth() + 1).padStart(2, '0');
            const sD = String(sundayDate.getDate()).padStart(2, '0');
            const sM = String(sundayDate.getMonth() + 1).padStart(2, '0');
            const weekRangeStr = `${mD}/${mM} al ${sD}/${sM}`;

            tardinessAuditList.push({
              dateStr: dateStr,
              timeStr: entradaRealStr,
              workStart: workStartStr,
              minsLate: minsLate,
              dictamen: dictamen,
              statusTag: statusTag,
              weekKey: weekKey,
              wNum: wNum,
              weekRangeStr: weekRangeStr,
              isTardanzaEfectiva: isTardanzaEfectiva
            });
          }
        }
      }

      curr.setDate(curr.getDate() + 1);
    }

    let totalFaltas6m = 0;
    let curr6m = new Date(dStart6m);
    while (curr6m <= dEnd && curr6m <= now) {
      const dateStr6m = getTodayNormalizedDateStr(curr6m);
      const dayOfWeek6m = curr6m.getDay();

      const justification = justificacionesDatabase.find(j => 
        String(j.dni || '').replace(/'/g, '').trim() === cleanDni && 
        normalizeDateStr(j.dateStr) === dateStr6m
      );

      const dStr = String(curr6m.getDate()).padStart(2, '0');
      const mStr = String(curr6m.getMonth() + 1).padStart(2, '0');
      const dayMonth = `${dStr}/${mStr}`;
      const isHoliday = GLOBAL_FERIADOS.includes(dayMonth) || !!feriadosDatabase.find(f => normalizeDateStr(f.dateStr) === dateStr6m);

      let daySched = null;
      let schedObj = emp.weeklySchedule;
      if (typeof schedObj === 'string' && schedObj.trim() !== '') {
        try { schedObj = JSON.parse(schedObj); } catch(e) { schedObj = null; }
      }
      if (schedObj && schedObj[dayOfWeek6m]) {
        daySched = schedObj[dayOfWeek6m];
      }
      if (!daySched) {
        if (dayOfWeek6m === 0) daySched = { isRestDay: true };
        else daySched = { isRestDay: false };
      }
      const isRestDay = !!daySched.isRestDay;

      const marks = datesMap[dateStr6m] || [];
      const hasIngreso = marks.some(m => m.action === 'Ingreso');

      if (!hasIngreso && !justification && !isRestDay && !isHoliday && !isFlex) {
        totalFaltas6m++;
      }

      curr6m.setDate(curr6m.getDate() + 1);
    }

    const convertedFaltas3to1 = Math.floor(totalTardanzasRango / 3);
    const totalEffectiveFaltasMes = totalFaltasMes + convertedFaltas3to1;
    const totalEffectiveFaltas6m = totalFaltas6m + convertedFaltas3to1;

    let rule1_excesoTolerancia = false;
    Object.keys(weeklyTardanzasMap).forEach(wk => {
      if (weeklyTardanzasMap[wk].toleranceUsedDays > 2 || weeklyTardanzasMap[wk].exceededQuota) {
        rule1_excesoTolerancia = true;
      }
    });

    let rule2_bajaAutomatica = !isFlex && maxConsecutiveAbsences >= 3;
    let rule3_retiroMes = !isFlex && (totalEffectiveFaltasMes >= 5 || convertedFaltas3to1 >= 3 || (convertedFaltas3to1 >= 2 && totalFaltasMes >= 1));
    let rule4_retiroSemestral = !isFlex && totalEffectiveFaltas6m >= 15;

    let finalStatus = 'En Regla';
    let statusClass = 'val-status-ok';
    let statusBadgeText = '✅ En Regla';
    let primaryCause = isFlex ? 'Horario Flexible - Exento de Infracciones' : 'Sin Infracciones Detectadas';

    if (rule2_bajaAutomatica) {
      finalStatus = 'Baja Automática';
      statusClass = 'val-status-baja';
      statusBadgeText = '🚨 Baja Automática';
      primaryCause = 'Inasistencia injustificada por 3 días consecutivos';
      countBaja++;
    } else if (rule3_retiroMes || rule4_retiroSemestral) {
      finalStatus = 'Causal de Retiro';
      statusClass = 'val-status-retiro';
      if ((convertedFaltas3to1 >= 3 || (convertedFaltas3to1 >= 2 && totalFaltasMes >= 1)) && !rule4_retiroSemestral) {
        statusBadgeText = '⛔ Retiro de la Empresa (Tardanzas Acumuladas)';
        primaryCause = convertedFaltas3to1 >= 3 
          ? 'Acumulación de 3 faltas por tardanzas (9 tardanzas efectivas)'
          : 'Combinación de 2 faltas por tardanza (6 tardanzas) y 1 falta injustificada';
      } else if (rule4_retiroSemestral) {
        statusBadgeText = '⛔ Retiro de la Empresa (15 Faltas 6 Meses)';
        primaryCause = 'Acumulación de 15 o más faltas en 6 meses';
      } else {
        statusBadgeText = '⛔ Retiro de la Empresa (5 Faltas Acumuladas)';
        primaryCause = 'Acumulación de 5 o más faltas en el mes';
      }
      countRetiro++;
    } else if (rule1_excesoTolerancia && !isFlex) {
      finalStatus = 'Exceso Tolerancia';
      statusClass = 'val-status-warning';
      statusBadgeText = '⚠️ Exceso Tolerancia';
      primaryCause = 'Más de 2 días de tolerancia a la semana o tardanzas >10m';
      countExceso++;
    }

    if (statusVal !== 'all' && finalStatus !== statusVal) {
      return;
    }

    countTotal++;

    cachedValidationDataMap[cleanDni] = {
      emp: emp,
      cleanDni: cleanDni,
      isFlex: isFlex,
      schedStr: schedStr,
      totalTardanzasRango: totalTardanzasRango,
      convertedFaltas3to1: convertedFaltas3to1,
      totalFaltasMes: totalFaltasMes,
      totalFaltas6m: totalFaltas6m,
      totalEffectiveFaltasMes: totalEffectiveFaltasMes,
      totalEffectiveFaltas6m: totalEffectiveFaltas6m,
      maxConsecutiveAbsences: maxConsecutiveAbsences,
      rule1_excesoTolerancia: rule1_excesoTolerancia,
      rule2_bajaAutomatica: rule2_bajaAutomatica,
      rule3_retiroMes: rule3_retiroMes,
      rule4_retiroSemestral: rule4_retiroSemestral,
      finalStatus: finalStatus,
      statusBadgeText: statusBadgeText,
      statusClass: statusClass,
      primaryCause: primaryCause,
      tardinessAuditList: tardinessAuditList,
      absenceAuditList: absenceAuditList
    };

    resultRows.push(cachedValidationDataMap[cleanDni]);
  });

  const elTotal = document.getElementById('val-stat-total');
  const elBaja = document.getElementById('val-stat-baja');
  const elRetiro = document.getElementById('val-stat-retiro');
  const elExceso = document.getElementById('val-stat-exceso');

  if (elTotal) elTotal.textContent = countTotal;
  if (elBaja) elBaja.textContent = countBaja;
  if (elRetiro) elRetiro.textContent = countRetiro;
  if (elExceso) elExceso.textContent = countExceso;

  renderValidationsTableRows(resultRows);
}

function renderValidationsTableRows(dataArray) {
  const tbody = document.getElementById('val-table-body');
  if (!tbody) return;
  tbody.innerHTML = '';

  const statusVal = document.getElementById('val-select-status')?.value || 'all';

  if (!dataArray || dataArray.length === 0) {
    let msg = 'No se encontraron registros que coincidan con los filtros aplicados.';
    if (statusVal !== 'all') {
      msg = `No existen colaboradores con dictamen <strong>"${escapeHtml(statusVal)}"</strong> en el rango seleccionado.<br><span style="font-size: 0.82rem; color: #64748b;">(Sugerencia: Cambie el filtro "Dictamen / Sanción" a <strong>"Todos los Estados"</strong> para visualizar el estado general).</span>`;
    }
    tbody.innerHTML = `<tr><td colspan="6" style="text-align: center; padding: 36px 20px; color: #94a3b8; line-height: 1.6;">${msg}</td></tr>`;
    return;
  }

  dataArray.forEach(item => {
    const emp = item.emp;
    const cleanDni = String(emp.dni || item.cleanDni).replace(/'/g, '').trim();

    // Lógica Metodológica de Badges para Tardanzas (3 = 1 Falta):
    // >= 3 faltas -> Rojo (danger)
    // == 2 faltas -> Naranja (warning)
    // == 1 falta  -> Azul (info)
    // == 0 faltas -> Neutral
    let tardinessBadgeClass = 'val-tardiness-neutral';
    if (item.convertedFaltas3to1 >= 3) {
      tardinessBadgeClass = 'val-tardiness-danger';
    } else if (item.convertedFaltas3to1 === 2) {
      tardinessBadgeClass = 'val-tardiness-warning';
    } else if (item.convertedFaltas3to1 === 1) {
      tardinessBadgeClass = 'val-tardiness-info';
    }

    // Lógica Metodológica de Badges para Faltas (Mes / 6M):
    // >= 5 faltas mes o >= 15 faltas 6M -> Rojo (danger)
    // >= 1 falta mes o >= 1 falta 6M    -> Naranja (warning)
    // == 0 -> Neutral
    let faltasBadgeClass = 'val-faltas-neutral';
    if (item.totalFaltasMes >= 5 || item.totalFaltas6m >= 15) {
      faltasBadgeClass = 'val-faltas-danger';
    } else if (item.totalFaltasMes >= 1 || item.totalFaltas6m >= 1) {
      faltasBadgeClass = 'val-faltas-warning';
    }

    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td class="table-employee-name">${escapeHtml(emp.name)}</td>
      <td>${escapeHtml(cleanDni)}</td>
      <td>
        <span class="val-tardiness-badge ${tardinessBadgeClass}">
          ${item.totalTardanzasRango} (${item.convertedFaltas3to1} faltas)
        </span>
      </td>
      <td>
        <span class="val-faltas-badge ${faltasBadgeClass}">
          ${item.totalFaltasMes} / ${item.totalFaltas6m}
        </span>
      </td>
      <td><span class="val-badge ${item.statusClass}">${item.statusBadgeText}</span></td>
      <td>
        <button type="button" class="btn-table-action btn-admin-edit" onclick="openValidationDetailsModal('${escapeHtml(cleanDni)}')" style="display: inline-flex; align-items: center; gap: 4px; padding: 6px 12px; cursor: pointer;">
          <span class="material-symbols-rounded" style="font-size: 16px;">search</span>
          <span>Ver Auditoría</span>
        </button>
      </td>
    `;
    tbody.appendChild(tr);
  });
}

function openValidationDetailsModal(dni) {
  const data = cachedValidationDataMap[dni];
  if (!data) return;

  const modal = document.getElementById('modal-validation-details');
  if (!modal) return;

  const emp = data.emp;
  document.getElementById('val-modal-emp-name').textContent = emp.name;
  document.getElementById('val-modal-emp-dni').textContent = emp.dni;
  document.getElementById('val-modal-emp-role').textContent = emp.role || 'Operaciones';

  const badgeEl = document.getElementById('val-modal-status-badge');
  if (badgeEl) {
    badgeEl.className = `val-badge ${data.statusClass}`;
    badgeEl.textContent = data.statusBadgeText;
  }

  document.getElementById('val-modal-stat-tardiness').textContent = data.totalTardanzasRango;
  document.getElementById('val-modal-stat-converted').textContent = data.convertedFaltas3to1;
  document.getElementById('val-modal-stat-month-faltas').textContent = data.totalFaltasMes;
  document.getElementById('val-modal-stat-total-faltas').textContent = data.totalFaltas6m;
  document.getElementById('val-modal-stat-consecutive').textContent = data.maxConsecutiveAbsences;

  const alertContainer = document.getElementById('val-modal-alert-container');
  if (alertContainer) {
    alertContainer.innerHTML = '';
    if (data.rule2_bajaAutomatica) {
      alertContainer.innerHTML += `<div class="val-alert-banner val-badge-baja" style="padding: 12px 16px; border-radius: 8px; font-weight: 500; display: flex; align-items: center; gap: 8px; margin-bottom: 12px;">
        <span class="material-symbols-rounded">warning</span>
        <span>Sanción Crítica (Regla 2): Inasistencia injustificada por 3 días consecutivos. Aplica Baja Automática del sistema.</span>
      </div>`;
    }
    if (data.rule3_retiroMes) {
      alertContainer.innerHTML += `<div class="val-alert-banner val-badge-retiro" style="padding: 12px 16px; border-radius: 8px; font-weight: 500; display: flex; align-items: center; gap: 8px; margin-bottom: 12px;">
        <span class="material-symbols-rounded">cancel</span>
        <span>Sanción (Regla 3): ${data.convertedFaltas3to1 >= 3 ? '3 faltas acumuladas por tardanzas (9 tardanzas en el mes). Causal de Retiro de la Empresa.' : 'Acumulación de 5 o más faltas en el mes. Causal de Retiro de la Empresa.'}</span>
      </div>`;
    }
    if (data.rule4_retiroSemestral && !data.rule3_retiroMes) {
      alertContainer.innerHTML += `<div class="val-alert-banner val-badge-retiro" style="padding: 12px 16px; border-radius: 8px; font-weight: 500; display: flex; align-items: center; gap: 8px; margin-bottom: 12px;">
        <span class="material-symbols-rounded">cancel</span>
        <span>Sanción (Regla 4): Acumulación de 15 o más faltas en el período de 6 meses. Causal de Retiro de la Empresa.</span>
      </div>`;
    }
    if (data.rule1_excesoTolerancia && !data.rule2_bajaAutomatica && !data.rule3_retiroMes && !data.rule4_retiroSemestral) {
      alertContainer.innerHTML += `<div class="val-alert-banner val-banner-warning" style="padding: 12px 16px; border-radius: 8px; font-weight: 500; display: flex; align-items: center; gap: 8px; margin-bottom: 12px;">
        <span class="material-symbols-rounded">info</span>
        <span>Observación (Regla 1): Ha superado los 2 días de tolerancia máxima de 10 min en la semana. Se aplicarán tardanzas acumulativas.</span>
      </div>`;
    }
  }

  const absencesContainer = document.getElementById('val-modal-absences-container');
  if (absencesContainer) {
    absencesContainer.innerHTML = '';
    const list = data.absenceAuditList || [];
    if (list.length === 0) {
      absencesContainer.innerHTML = `<span style="color: var(--text-muted, #94a3b8); font-size: 0.85rem; padding: 4px;">No se registraron faltas injustificadas en el período auditado.</span>`;
    } else {
      list.forEach(a => {
        const badge = document.createElement('span');
        badge.className = 'val-absence-badge';
        badge.innerHTML = `<span class="material-symbols-rounded" style="font-size: 14px;">event_busy</span> <span>${escapeHtml(a.dateStr)}</span>`;
        absencesContainer.appendChild(badge);
      });
    }
  }

  const tbody = document.getElementById('val-modal-tardiness-tbody');
  if (tbody) {
    tbody.innerHTML = '';
    const list = data.tardinessAuditList || [];
    if (list.length === 0) {
      tbody.innerHTML = `<tr><td colspan="5" style="text-align: center; padding: 24px; color: #94a3b8;">No se registraron tardanzas ni incidencias en el período auditado.</td></tr>`;
    } else {
      let lastWeekKey = '';
      list.forEach(t => {
        if (t.weekKey !== lastWeekKey) {
          lastWeekKey = t.weekKey;
          const trHeader = document.createElement('tr');
          trHeader.className = 'val-week-divider-row';
          trHeader.innerHTML = `
            <td colspan="5" style="background: rgba(99, 102, 241, 0.12); color: #818cf8; font-weight: 700; font-size: 0.8rem; padding: 8px 12px; border-top: 1px solid rgba(99, 102, 241, 0.25); border-bottom: 1px solid rgba(99, 102, 241, 0.25);">
              <span class="material-symbols-rounded" style="font-size: 16px; vertical-align: text-bottom; margin-right: 4px;">date_range</span>
              <span>Semana ${t.wNum} (Rango: ${t.weekRangeStr})</span>
            </td>
          `;
          tbody.appendChild(trHeader);
        }

        let pillClass = 'val-pill-tolerated';
        if (t.statusTag === 'exceeded') pillClass = 'val-pill-exceeded';
        else if (t.statusTag === 'quota_exceeded') pillClass = 'val-pill-quota';

        const tr = document.createElement('tr');
        tr.innerHTML = `
          <td><span style="background: rgba(99, 102, 241, 0.18); color: #818cf8; border: 1px solid rgba(99, 102, 241, 0.3); padding: 2px 8px; border-radius: 12px; font-weight: 600; font-size: 0.78rem;">Sem. ${t.wNum}</span></td>
          <td>${t.dateStr}</td>
          <td>${t.timeStr} (Inicio: ${t.workStart})</td>
          <td style="font-weight: 600;" class="val-text-amber">+${t.minsLate} min</td>
          <td><span class="val-pill-dictamen ${pillClass}">${t.dictamen}</span></td>
        `;
        tbody.appendChild(tr);
      });
    }
  }

  modal.classList.remove('hidden');
}

function exportValidationsReportExcel() {
  const staffKeys = Object.keys(cachedValidationDataMap);
  if (staffKeys.length === 0) {
    showToast('warning', 'Sin datos', 'No hay datos de validaciones para exportar.');
    return;
  }

  let csvContent = "\uFEFF";
  csvContent += "DNI;Colaborador;Tipo Horario;Estado Final;Causa Principal;Tardanzas;Faltas 3to1;Faltas Mes;Total Faltas Efectivas;Max Consecutivas\n";

  staffKeys.forEach(key => {
    const d = cachedValidationDataMap[key];
    const emp = d.emp;
    const name = `"${(emp.name || '').replace(/"/g, '""')}"`;
    const cause = `"${(d.primaryCause || '').replace(/"/g, '""')}"`;
    const line = [
      emp.dni,
      name,
      d.schedStr,
      d.finalStatus,
      cause,
      d.totalTardanzasRango,
      d.convertedFaltas3to1,
      d.totalFaltasRango,
      d.totalEffectiveFaltas,
      d.maxConsecutiveAbsences
    ].join(";");
    csvContent += line + "\n";
  });

  const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `Reporte_Validaciones_Sanciones_${formatDateToInputISO(new Date())}.csv`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);

  showToast('success', 'Exportación Completa', 'Reporte de Validaciones exportado en formato CSV Excel.');
}
