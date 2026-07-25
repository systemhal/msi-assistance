/**
 * AsistenciaPro - Google Apps Script Integration Backend
 * 
 * Copia y pega este código completo en tu editor de Google Apps Script 
 * (Extensiones -> Apps Script) y luego despliégalo como una Aplicación Web.
 */

// Configuración de CORS y cabeceras
function getJsonResponse(data) {
  return ContentService.createTextOutput(JSON.stringify(data))
    .setMimeType(ContentService.MimeType.JSON);
}

// Inicializar hojas si no existen o tienen menos columnas (Autoreparable)
function ensureSheetsExist() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  
  var sheets = {
    "Personal": ["Fecha", "Dni", "Nombre Completo", "Edad", "Sexo", "Cargo / Puesto", "Entrada Jornada", "Salida Jornada", "Inicio Break", "Fin Break", "PIN", "Horarios Semanales"],
    "Asistencia": ["Fecha", "Hora", "DNI", "Nombre Colaborador", "Acción", "Detalles", "Timestamp Unix", "Dispositivo"],
    "Justificaciones": ["DNI", "Fecha", "Tipo", "Detalles", "Hora Inicio", "Hora Fin", "¿Con Goce?"],
    "Feriados": ["Fecha", "Nombre"],
    "Horarios": ["Día", "DNI", "Nombre Completo", "Entrada - Salida", "Hrs"]
  };
  
  for (var name in sheets) {
    var sheet = ss.getSheetByName(name);
    if (!sheet) {
      sheet = ss.insertSheet(name);
      sheet.appendRow(sheets[name]);
      // Dar formato de cabecera negrita
      sheet.getRange(1, 1, 1, sheets[name].length).setFontWeight("bold");
    } else {
      // Verificar si la hoja tiene suficientes columnas para las expectativas
      var expectedHeaders = sheets[name];
      var maxCols = sheet.getMaxColumns();
      if (maxCols < expectedHeaders.length) {
        sheet.insertColumnsAfter(maxCols, expectedHeaders.length - maxCols);
      }
      
      // Leer cabeceras actuales y asegurar que todas estén escritas
      var currentHeaders = sheet.getRange(1, 1, 1, expectedHeaders.length).getDisplayValues()[0];
      for (var colIdx = 0; colIdx < expectedHeaders.length; colIdx++) {
        if (!currentHeaders[colIdx] || currentHeaders[colIdx].trim() === "") {
          sheet.getRange(1, colIdx + 1).setValue(expectedHeaders[colIdx]).setFontWeight("bold");
        }
      }
    }
  }
}

// Helper para dar formato a los valores de tiempo (evita que se serialicen como fechas ISO corruptas)

// Helper para convertir cualquier DNI a texto plano (incluso si Sheets lo interpretó como fecha y retornó un objeto Date)
function getSafeDni(val) {
  if (!val) return "";
  if (val instanceof Date) {
    var epoch = new Date(1899, 11, 30);
    return String(Math.round((val.getTime() - epoch.getTime()) / (24 * 60 * 60 * 1000)));
  }
  return String(val).trim();
}

function formatTimeValue(val) {
  if (!val) return "—";
  if (val instanceof Date) {
    return Utilities.formatDate(val, Session.getScriptTimeZone(), "HH:mm");
  }
  var s = String(val).trim();
  if (s === "" || s === "—") return "—";
  return s;
}

// Helper para dar formato a fechas de Excel/Sheets
function formatDateValue(val) {
  if (!val) return "";
  if (val instanceof Date) {
    return Utilities.formatDate(val, Session.getScriptTimeZone(), "dd/MM/yyyy");
  }
  var s = String(val).trim();
  // Si es una fecha ISO, parsear e imponer formato dd/MM/yyyy
  if (s.indexOf('T') > 0 && !isNaN(Date.parse(s))) {
    try {
      return Utilities.formatDate(new Date(s), Session.getScriptTimeZone(), "dd/MM/yyyy");
    } catch(e) {}
  }
  return s;
}

// Helper para dar formato a horas largas (con segundos)
function formatLongTimeValue(val) {
  if (!val) return "";
  if (val instanceof Date) {
    return Utilities.formatDate(val, Session.getScriptTimeZone(), "HH:mm:ss");
  }
  return String(val).trim();
}

var DEFAULT_API_KEY = "AsistenciaPro_SecuredKey_2026";

function getStoredApiKey() {
  var props = PropertiesService.getScriptProperties();
  var key = props.getProperty("API_KEY");
  return (key && key.trim() !== "") ? key.trim() : DEFAULT_API_KEY;
}

function checkAuth(e, postData) {
  var providedKey = "";
  if (e && e.parameter && e.parameter.apiKey) {
    providedKey = String(e.parameter.apiKey).trim();
  } else if (postData && postData.apiKey) {
    providedKey = String(postData.apiKey).trim();
  }
  return providedKey === getStoredApiKey();
}

// ── GET REQUESTS (Sincronización hacia la App Web) ────────────────────────
function doGet(e) {
  ensureSheetsExist();
  
  if (!checkAuth(e, null)) {
    return getJsonResponse({ status: "error", message: "Acceso denegado: API Key no válida o no proporcionada." });
  }

  var action = e.parameter.action;
  
  if (!action) {
    return getJsonResponse({ status: "error", message: "Falta el parámetro 'action'." });
  }
  
  try {
    var ss = SpreadsheetApp.getActiveSpreadsheet();
    
    // 1. Obtener base de datos unificada (Acción optimizada principal)
    if (action === 'get_initial_data') {
      var props = PropertiesService.getScriptProperties();
      return getJsonResponse({
        status: "ok",
        data: {
          employees: getEmployeesData(ss),
          justificaciones: getJustificacionesData(ss),
          feriados: getFeriadosData(ss),
          history: getHistoryData(ss),
          config: {
            security_block_mobile: props.getProperty('security_block_mobile') === 'true',
            security_restrict_pcs: props.getProperty('security_restrict_pcs') === 'true',
            tardiness_tolerance: props.getProperty('tardiness_tolerance') ? parseInt(props.getProperty('tardiness_tolerance'), 10) : 5,
            api_key: getStoredApiKey()
          }
        }
      });
    }
    
    // 2. Obtener lista de colaboradores
    if (action === 'get_employees') {
      return getJsonResponse({ status: "ok", data: getEmployeesData(ss) });
    }
    
    // 3. Obtener justificaciones
    if (action === 'get_justificaciones') {
      return getJsonResponse({ status: "ok", data: getJustificacionesData(ss) });
    }
    
    // 4. Obtener feriados
    if (action === 'get_feriados') {
      return getJsonResponse({ status: "ok", data: getFeriadosData(ss) });
    }
    
    // 5. Obtener historial general o por empleado
    if (action === 'get_history') {
      var dni = e.parameter.dni;
      return getJsonResponse({ status: "ok", data: getHistoryData(ss, dni) });
    }
    
    return getJsonResponse({ status: "error", message: "Acción GET no reconocida." });
    
  } catch (err) {
    return getJsonResponse({ status: "error", message: err.toString() });
  }
}

// ── POST REQUESTS (Inserciones y ediciones desde la App Web) ───────────────
function doPost(e) {
  ensureSheetsExist();
  
  try {
    var postData = JSON.parse(e.postData.contents);
    
    if (!checkAuth(e, postData)) {
      return getJsonResponse({ status: "error", message: "Acceso denegado: API Key no válida o no proporcionada." });
    }

    var action = postData.action;
    
    if (!action) {
      return getJsonResponse({ status: "error", message: "Acción POST no especificada." });
    }
    
    var ss = SpreadsheetApp.getActiveSpreadsheet();

    // 0. Guardar Configuración Global de Seguridad
    if (action === "Guardar_Configuracion") {
      var props = PropertiesService.getScriptProperties();
      if (postData.security_block_mobile !== undefined) {
        props.setProperty('security_block_mobile', String(postData.security_block_mobile === true || postData.security_block_mobile === 'true'));
      }
      if (postData.security_restrict_pcs !== undefined) {
        props.setProperty('security_restrict_pcs', String(postData.security_restrict_pcs === true || postData.security_restrict_pcs === 'true'));
      }
      if (postData.tardiness_tolerance !== undefined) {
        props.setProperty('tardiness_tolerance', String(postData.tardiness_tolerance));
      }
      if (postData.api_key !== undefined && String(postData.api_key).trim() !== "") {
        props.setProperty('API_KEY', String(postData.api_key).trim());
      }
      return getJsonResponse({ status: "ok", message: "Configuración global de seguridad guardada." });
    }
    
    // 1. Registrar Nuevo Colaborador
    if (action === "Registrar_Personal") {
      var sheet = ss.getSheetByName("Personal");
      sheet.appendRow([
        Utilities.formatDate(new Date(), Session.getScriptTimeZone(), "dd/MM/yyyy"), // 1. Fecha (A)
        "'" + postData.employeeId,      // 2. Dni (B)
        postData.employeeName,    // 3. Nombre Completo (C)
        postData.age || "—",      // 4. Edad (D)
        postData.gender || "—",   // 5. Sexo (E)
        postData.role || "Colaborador", // 6. Cargo / Puesto (F)
        postData.workStart || "08:00", // 7. Entrada Jornada (G)
        postData.workEnd || "17:00",   // 8. Salida Jornada (H)
        postData.breakStart || "13:00", // 9. Inicio Break (I)
        postData.breakEnd || "14:00",   // 10. Fin Break (J)
        postData.pin || "1234",   // 11. PIN (K)
        postData.weeklySchedule || ""   // 12. Horarios Semanales (L)
      ]);
      updateHorariosSheet(ss, postData.employeeId, postData.employeeName, postData.weeklySchedule || "");
      return getJsonResponse({ status: "ok", message: "Colaborador registrado." });
    }
    
    // 2. Editar Colaborador Existente
    if (action === "Editar_Personal") {
      var sheet = ss.getSheetByName("Personal");
      var data = sheet.getDataRange().getValues();
      var foundRow = -1;
      
      var empIdStr = getSafeDni(postData.employeeId);
      for (var i = 1; i < data.length; i++) {
        if (getSafeDni(data[i][1]) === empIdStr) { // Buscar en Columna B (Dni)
          foundRow = i + 1;
          break;
        }
      }
      
      if (foundRow >= 0) {
        sheet.getRange(foundRow, 2, 1, 11).setValues([[
          postData.employeeId,      // 2. Dni (B)
          postData.employeeName,    // 3. Nombre Completo (C)
          postData.age || "—",      // 4. Edad (D)
          postData.gender || "—",   // 5. Sexo (E)
          postData.role,            // 6. Cargo / Puesto (F)
          postData.workStart,       // 7. Entrada Jornada (G)
          postData.workEnd,         // 8. Salida Jornada (H)
          postData.breakStart,      // 9. Inicio Break (I)
          postData.breakEnd,        // 10. Fin Break (J)
          postData.pin,             // 11. PIN (K)
          postData.weeklySchedule || "" // 12. Horarios Semanales (L)
        ]]);
        updateHorariosSheet(ss, postData.employeeId, postData.employeeName, postData.weeklySchedule || "");
        return getJsonResponse({ status: "ok", message: "Colaborador actualizado." });
      }
      return getJsonResponse({ status: "error", message: "Colaborador no encontrado." });
    }
    
    // 3. Eliminar Colaborador
    if (action === "Eliminar_Personal") {
      var sheet = ss.getSheetByName("Personal");
      var data = sheet.getDataRange().getValues();
      var empIdStr = getSafeDni(postData.employeeId);
      for (var i = 1; i < data.length; i++) {
        if (getSafeDni(data[i][1]) === empIdStr) { // Buscar en Columna B (Dni)
          sheet.deleteRow(i + 1);
          break;
        }
      }
      deleteFromHorariosSheet(ss, postData.employeeId);
      return getJsonResponse({ status: "ok", message: "Colaborador eliminado." });
    }
    
    // 4. Registrar Justificación
    if (action === "Registrar_Justificacion") {
      var sheet = ss.getSheetByName("Justificaciones");
      var data = sheet.getDataRange().getValues();
      var foundRow = -1;
      
      for (var i = 1; i < data.length; i++) {
        if (getSafeDni(data[i][0]) === getSafeDni(postData.employeeId) && data[i][1] === postData.date) {
          foundRow = i + 1;
          break;
        }
      }
      var sheetJust = ss.getSheetByName("Justificaciones");
      var payload = postData;
      var employeeId = payload.employeeId;
      
      const { date, type, startTime, endTime, compensation } = payload; // date en formato DD/MM/YYYY, type es "Vacaciones", etc.
      const desc = payload.details || "";
      if (!employeeId || !date || !type) {
        return getJsonResponse({ status: "error", message: "Faltan campos obligatorios para registrar la justificación." });
      }
      
      // Evitar duplicados en la misma fecha y DNI: borrar la anterior
      let displayData = sheetJust.getDataRange().getDisplayValues();
      for (let i = displayData.length - 1; i > 0; i--) {
        if (getSafeDni(displayData[i][0]) === getSafeDni(employeeId) && formatDateValue(displayData[i][1]) === formatDateValue(date)) {
          sheetJust.deleteRow(i + 1);
        }
      }
      
      sheetJust.appendRow([
        String(employeeId), 
        String(date), 
        String(type), 
        String(desc),
        String(startTime || ""),
        String(endTime || ""),
        String(compensation || "")
      ]);
      return getJsonResponse({ status: "ok", message: "Justificación registrada exitosamente." });
    }
    
    // 5. Eliminar Justificación
    if (action === "Eliminar_Justificacion") {
      var sheet = ss.getSheetByName("Justificaciones");
      var data = sheet.getDataRange().getValues();
      var targetDni = getSafeDni(postData.employeeId);
      for (var i = 1; i < data.length; i++) {
        if (getSafeDni(data[i][0]) === targetDni && formatDateValue(data[i][1]) === formatDateValue(postData.date)) {
          sheet.deleteRow(i + 1);
          break;
        }
      }
      return getJsonResponse({ status: "ok", message: "Justificación eliminada." });
    }
    
    // 6. Registrar Feriado Personalizado
    if (action === "Registrar_Feriado") {
      var sheet = ss.getSheetByName("Feriados");
      var data = sheet.getDataRange().getValues();
      var foundRow = -1;
      
      for (var i = 1; i < data.length; i++) {
        if (formatDateValue(data[i][0]) === formatDateValue(postData.date)) {
          foundRow = i + 1;
          break;
        }
      }
      
      if (foundRow >= 0) {
        sheet.getRange(foundRow, 2).setValue(postData.name);
      } else {
        sheet.appendRow([postData.date, postData.name]);
      }
      return getJsonResponse({ status: "ok", message: "Feriado registrado." });
    }
    
    // 7. Eliminar Feriado
    if (action === "Eliminar_Feriado") {
      var sheet = ss.getSheetByName("Feriados");
      var data = sheet.getDataRange().getValues();
      for (var i = 1; i < data.length; i++) {
        if (formatDateValue(data[i][0]) === formatDateValue(postData.date)) {
          sheet.deleteRow(i + 1);
          break;
        }
      }
      return getJsonResponse({ status: "ok", message: "Feriado eliminado." });
    }
    
    // 8. Marcas de Asistencia (Acciones: Ingreso, Inicio Refrigerio, Fin Refrigerio, Salida)
    var attendanceSheet = ss.getSheetByName("Asistencia");
    
    // Determinar la fecha y hora actual si no viene customizado
    var now = new Date();
    var formattedDate = postData.customDate || Utilities.formatDate(now, Session.getScriptTimeZone(), "dd/MM/yyyy");
    var formattedTime = postData.customTime || Utilities.formatDate(now, Session.getScriptTimeZone(), "HH:mm:ss");
    var timestamp = postData.customTimestamp || now.getTime();
    
    attendanceSheet.appendRow([
      formattedDate,            // 1. Fecha (A)
      formattedTime,            // 2. Hora (B)
      "'" + postData.employeeId,      // 3. DNI (C)
      postData.employeeName,    // 4. Nombre Colaborador (D)
      action,                   // 5. Acción (E)
      postData.details || "Registrado vía AsistenciaPro Web", // 6. Detalles (F)
      timestamp,                // 7. Timestamp Unix (G)
      postData.device || "---"  // 8. Dispositivo (H)
    ]);
    
    return getJsonResponse({ status: "ok", message: "Marca registrada con éxito." });
    
  } catch (err) {
    return getJsonResponse({ status: "error", message: err.toString() });
  }
}

// ── GETTERS DE BASES DE DATOS (MÉTODOS INTERNOS) ──────────────────────────

function getEmployeesData(ss) {
  var sheet = ss.getSheetByName("Personal");
  if (!sheet) return [];
  
  var data = sheet.getDataRange().getValues();
  var employees = [];
  
  for (var i = 1; i < data.length; i++) {
    employees.push({
      dni: getSafeDni(data[i][1]), // Columna B (Dni)
      name: data[i][2],        // Columna C (Nombre Completo)
      age: data[i][3],        // Columna D (Edad)
      gender: data[i][4],     // Columna E (Sexo)
      role: data[i][5],       // Columna F (Cargo / Puesto)
      workStart: formatTimeValue(data[i][6]),  // Columna G (Entrada Jornada)
      workEnd: formatTimeValue(data[i][7]),    // Columna H (Salida Jornada)
      breakStart: formatTimeValue(data[i][8]), // Columna I (Inicio Break)
      breakEnd: formatTimeValue(data[i][9]),   // Columna J (Fin Break)
      pin: String(data[i][10]), // Columna K (PIN)
      weeklySchedule: data[i][11] || "" // Columna L (Horarios Semanales)
    });
  }
  return employees;
}

function getJustificacionesData(ss) {
  var sheet = ss.getSheetByName("Justificaciones");
  if (!sheet) return [];
  
  var data = sheet.getDataRange().getValues();
  var list = [];
  for (var i = 1; i < data.length; i++) {
    var sTime = data[i][4] ? formatTimeValue(data[i][4]) : "";
    if (sTime === "—") sTime = "";
    var eTime = data[i][5] ? formatTimeValue(data[i][5]) : "";
    if (eTime === "—") eTime = "";

    list.push({
      dni: getSafeDni(data[i][0]),
      dateStr: formatDateValue(data[i][1]),
      type: data[i][2],
      details: data[i][3],
      startTime: sTime,
      endTime: eTime,
      compensation: data[i][6] || ""
    });
  }
  return list;
}

function getFeriadosData(ss) {
  var sheet = ss.getSheetByName("Feriados");
  if (!sheet) return [];
  
  var data = sheet.getDataRange().getValues();
  var list = [];
  for (var i = 1; i < data.length; i++) {
    list.push({
      dateStr: formatDateValue(data[i][0]),
      name: data[i][1]
    });
  }
  return list;
}

function getHistoryData(ss, filterDni) {
  var sheet = ss.getSheetByName("Asistencia");
  if (!sheet) return [];
  
  var data = sheet.getDataRange().getValues();
  var history = [];
  
  for (var i = 1; i < data.length; i++) {
    var dni = getSafeDni(data[i][2]); // Columna C (DNI)
    if (filterDni && dni !== String(filterDni)) continue;
    
    history.push({
      dni: dni,                          // DNI
      name: data[i][3],                  // Nombre Colaborador
      action: data[i][4],                // Acción
      dateStr: formatDateValue(data[i][0]),     // Fecha (A)
      timeStr: formatLongTimeValue(data[i][1]), // Hora (B)
      timestamp: Number(data[i][6]),     // Timestamp Unix (G)
      details: data[i][5],               // Detalles (F)
      device: data[i][7]                 // Dispositivo (H)
    });
  }
  return history;
}

// ── SISTEMA DE SINCRONIZACIÓN EN LA PESTAÑA "HORARIOS" ────────────────────

function updateHorariosSheet(ss, employeeId, name, weeklySchedule) {
  var sheet = ss.getSheetByName("Horarios");
  if (!sheet) return;
  
  // 1. Primero, eliminar todas las filas existentes de este DNI en "Horarios"
  // Buscamos en columna A (por si acaso quedó el formato horizontal anterior) y columna B (DNI oficial en formato vertical)
  var data = sheet.getDataRange().getValues();
  for (var i = data.length - 1; i > 0; i--) {
    if (getSafeDni(data[i][0]) === String(employeeId) || String(data[i][1]) === String(employeeId)) {
      sheet.deleteRow(i + 1);
    }
  }
  
  // 2. Parsear el weeklySchedule
  var sched = {};
  var isFlexible = (weeklySchedule === "flexible");
  if (!isFlexible && weeklySchedule) {
    try {
      sched = JSON.parse(weeklySchedule);
    } catch(e) {
      sched = {};
    }
  }
  
  var daysOrder = [
    { key: "1", label: "Lunes" },
    { key: "2", label: "Martes" },
    { key: "3", label: "Miércoles" },
    { key: "4", label: "Jueves" },
    { key: "5", label: "Viernes" },
    { key: "6", label: "Sábado" },
    { key: "0", label: "Domingo" }
  ];
  
  // 3. Escribir las 7 nuevas filas para el colaborador
  for (var j = 0; j < daysOrder.length; j++) {
    var dayObj = daysOrder[j];
    var timeStr = "";
    var hours = 0;
    
    if (isFlexible) {
      timeStr = "Flexible";
      hours = 0;
    } else {
      var daySched = sched[dayObj.key];
      if (daySched) {
        if (daySched.isRestDay) {
          timeStr = ""; // Celda en blanco para días de descanso en Entrada - Salida
          hours = 0;
        } else {
          timeStr = (daySched.workStart || "09:00") + " - " + (daySched.workEnd || "18:00");
          if (daySched.nobreak) {
            timeStr += " (S/B)";
          }
          hours = daySched.expectedHours !== undefined ? Number(daySched.expectedHours) : 8;
        }
      } else {
        timeStr = "—";
        hours = 0;
      }
    }
    
    sheet.appendRow([
      dayObj.label,        // A: Día
      String(employeeId),  // B: DNI
      String(name),        // C: Nombre Completo
      timeStr,             // D: Entrada - Salida
      hours                // E: Hrs
    ]);
  }
}

function deleteFromHorariosSheet(ss, employeeId) {
  var sheet = ss.getSheetByName("Horarios");
  if (!sheet) return;
  
  var data = sheet.getDataRange().getValues();
  for (var i = data.length - 1; i > 0; i--) {
    if (getSafeDni(data[i][0]) === String(employeeId) || getSafeDni(data[i][1]) === String(employeeId)) {
      sheet.deleteRow(i + 1);
    }
  }
}
