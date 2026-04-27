// ── Cloud-Only Dashboard Script ────────────────────────────────
// This app.js is strictly for hosting on GitHub Pages or other 
// public web servers. It completely ignores Local fallback and 
// talks exclusively directly to HiveMQ Cloud.

const CLOUD_HOST = "1292289970a44908b91cc39e1579e841.s1.eu.hivemq.cloud";
const CLOUD_PORT = 8884; // standard WSS port for HiveMQ Cloud
const CLOUD_USER = "HAsiB";
const CLOUD_PASS = "HAsiB@@17";

let mqttClient    = null;
let lastLdrPct = 0, lastLdrRaw = 0;  // track last known LDR values for display refresh

// ── Status bar ────────────────────────────────────────────────
const $ = id => document.getElementById(id);
const dom = {};
function cacheDOM() {
    dom.status   = $('status');
    dom.ldrBdg   = $('ldrBdg');
    dom.ldrBar   = $('ldrBar');
    dom.ldrRaw   = $('ldrRaw');
    dom.ldrPct   = $('ldrPct');
    dom.ldrThr   = $('ldrThrDisp');
    dom.valveSt  = $('valveSt');
    dom.schedCont= $('schedCont');
}

function setStatus(online) {
    if (!dom.status) return;
    if (!online) {
        dom.status.textContent = '● Offline';
        dom.status.className   = 'err';
    } else {
        dom.status.textContent = '☁ Cloud (Remote Only)';
        dom.status.className   = 'ok';
    }
}

// ── State ─────────────────────────────────────────────────────
// Note: cfg.ldr_en defaults to true — cloud dashboard has no access to
// ESP32 HTTP API, so we assume LDR is enabled until told otherwise via MQTT.
let cfg = { ldr_en: true, ldr_ctrl: false, ldr_thresh: 50 };
const m1T = Array(10).fill(false), m2T = Array(10).fill(false), m3T = Array(4).fill(false);
let schedData = [
    { startH:6,startM:0,startPM:false,stopH:7,stopM:0,stopPM:false,enabled:false },
    { startH:6,startM:0,startPM:false,stopH:7,stopM:0,stopPM:false,enabled:false },
    { startH:6,startM:0,startPM:false,stopH:7,stopM:0,stopPM:false,enabled:false }
];

const FL = ['Fan','LED Light','Tube Light','Dim Light','Door Light'];
const BL = ['Fan','LED Light','Tube Light','Dim Light','Door Light'];
const RL = ['Relay 1','Relay 2','Relay 3','Relay 4','Relay 5',
             'Relay 6','Relay 7','Relay 8','Relay 9','Relay 10'];

// ── Build relay grids ─────────────────────────────────────────
function buildGrid(id, device, startIdx, labels) {
    const g = $(id); if (!g) return; g.innerHTML = '';
    const frag = document.createDocumentFragment();
    for (let i = 0; i < labels.length; i++) {
        const n = startIdx + i;
        const d = document.createElement('div');
        d.className = 'row'; d.id = 'row-' + device + '-' + n;
        d.innerHTML =
            '<span class="lbl">' + labels[i] + '</span>' +
            '<label class="tog"><input type="checkbox" id="r-' + device + '-' + n +
            '" onchange="setRelay(\'' + device + '\',' + n + ',this.checked)">' +
            '<span class="sl"></span></label>';
        frag.appendChild(d);
    }
    g.appendChild(frag);
}

function updateRelay(device, n, on) {
    const el  = $('r-' + device + '-' + n);
    const row = $('row-' + device + '-' + n);
    if (el)  el.checked    = on;
    if (row) row.className = 'row' + (on ? ' on' : '');
}

// ── MQTT Message Handler ──────────────────────────────────────
function setupMessageHandler(client) {
    client.on('message', function (topic, message) {
        let data;
        try { data = JSON.parse(message.toString()); }
        catch (e) { data = message.toString(); }

        if (topic.startsWith('home/esp32/relay') && topic.endsWith('/state')) {
            const m = topic.match(/relay(\d+)\/state$/);
            if (m) updateRelay('esp32', +m[1], data.state === 'ON');
            return;
        }
        if (topic.startsWith('home/esp8266/relay') && topic.endsWith('/state')) {
            const m = topic.match(/relay(\d+)\/state$/);
            if (m) updateRelay('esp8266', +m[1], data.state === 'ON');
            return;
        }
        if (topic === 'home/esp8266/valve/state') {
            const vs = dom.valveSt; if (!vs) return;
            if (data.motorState === 'FORWARD') { vs.textContent='Valve: OPENING...'; vs.className='valve open'; }
            else if (data.motorState === 'REVERSE') { vs.textContent='Valve: CLOSING...'; vs.className='valve closed'; }
            else if (data.open) { vs.textContent='Valve: OPEN (Watering)'; vs.className='valve open'; }
            else { vs.textContent='Valve: CLOSED'; vs.className='valve closed'; }
            return;
        }
        if (topic === 'home/esp32/ldr/reading') { updateLdr(data.pct||0, data.raw||0); return; }
    });
}

// ── MQTT Connect: Cloud Only (wss://) ────────────────────────
function startMQTT() {
    const wsUrl = 'wss://' + CLOUD_HOST + ':' + CLOUD_PORT + '/mqtt';
    console.log('[MQTT] Connecting pure cloud:', wsUrl);

    const opts = {
        clientId: 'remote_dash_' + Math.random().toString(16).substr(2, 8),
        reconnectPeriod: 3000, 
        username: CLOUD_USER,
        password: CLOUD_PASS
    };

    const client = mqtt.connect(wsUrl, opts);

    client.on('connect', () => {
        setStatus(true);
        client.subscribe('home/#');
        setupMessageHandler(client);
        mqttClient = client;
        console.log('[MQTT] Connected to cloud broker');
    });

    client.on('offline', () => setStatus(false));
}

// ── Relay toggle ──────────────────────────────────────────────
function setRelay(device, n, on) {
    updateRelay(device, n, on);
    if (mqttClient) mqttClient.publish('home/' + device + '/relay' + n + '/command',
                                        JSON.stringify({ state: on ? 'ON' : 'OFF' }));
}

function valveCmd(a) {
    const vs = dom.valveSt;
    if (vs) { vs.textContent = a==='open'?'Valve: OPENING...':'Valve: CLOSING...'; vs.className='valve '+(a==='open'?'open':'closed'); }
    if (mqttClient) mqttClient.publish('home/esp8266/valve/command', JSON.stringify({ action: a }));
}

// ── LDR display ───────────────────────────────────────────────
function updateLdr(pct, raw) {
    lastLdrPct = pct; lastLdrRaw = raw;
    const thr = cfg.ldr_thresh||50;
    // Use !== false so that undefined (not yet received) defaults to showing data
    const ldrOn = (cfg.ldr_en !== false);
    const display = ldrOn ? pct : 0;
    if (dom.ldrPct) dom.ldrPct.textContent = ldrOn ? pct+'%' : '--';
    if (dom.ldrRaw) dom.ldrRaw.textContent = ldrOn ? raw : '--';
    if (dom.ldrBar) { dom.ldrBar.style.width=display+'%'; dom.ldrBar.style.background=pct>=thr?'#FFC107':'#2196F3'; }
    if (dom.ldrThr) dom.ldrThr.textContent=thr+'%';
    const bdg=dom.ldrBdg; if (!bdg) return;
    if (!ldrOn) { bdg.className='bdg bdg-x'; bdg.textContent='LDR Disabled'; }
    else if (pct>=thr&&cfg.ldr_ctrl) { bdg.className='bdg bdg-r'; bdg.textContent='Daylight \u2014 Motion Blocked'; }
    else if (cfg.ldr_ctrl) { bdg.className='bdg bdg-g'; bdg.textContent='Dark \u2014 Motion Active'; }
    else { bdg.className='bdg bdg-x'; bdg.textContent='LDR Override Off'; }
}

// ── Offline Settings UI helpers ──────────────────────────────
// Remote dashboard cannot fetch settings from ESP32 local IP. 
// It relies entirely on MQTT for active control.
const LS_CFG='sh_cfg_rm', LS_SCHED='sh_sched_rm';

function renderSchedules() {
    const c=dom.schedCont;if(!c)return;
    const frag=document.createDocumentFragment();
    for(let i=0;i<3;i++){
        const s=schedData[i],div=document.createElement('div');div.className='sc';
        div.innerHTML='<b>Schedule '+(i+1)+'</b><div style="margin-top:8px"><label><input type="checkbox" id="sen'+i+'"'+(s.enabled?' checked':'')+'>Enabled</label></div>'+
            '<div class="frow" style="margin-top:8px"><span>Start:</span><input type="number" id="ssh'+i+'" min="1" max="12" value="'+(s.startH||6)+'" style="width:56px;padding:5px;border:1px solid #ddd;border-radius:4px">:<input type="number" id="ssm'+i+'" min="0" max="59" value="'+(s.startM||0)+'" style="width:56px;padding:5px;border:1px solid #ddd;border-radius:4px"><select id="ssp'+i+'" style="padding:5px;border:1px solid #ddd;border-radius:4px"><option value="0"'+(!s.startPM?' selected':'')+'>AM</option><option value="1"'+(s.startPM?' selected':'')+'>PM</option></select></div>'+
            '<div class="frow" style="margin-top:6px"><span>Stop: </span><input type="number" id="stph'+i+'" min="1" max="12" value="'+(s.stopH||7)+'" style="width:56px;padding:5px;border:1px solid #ddd;border-radius:4px">:<input type="number" id="stpm'+i+'" min="0" max="59" value="'+(s.stopM||0)+'" style="width:56px;padding:5px;border:1px solid #ddd;border-radius:4px"><select id="stpp'+i+'" style="padding:5px;border:1px solid #ddd;border-radius:4px"><option value="0"'+(!s.stopPM?' selected':'')+'>AM</option><option value="1"'+(s.stopPM?' selected':'')+'>PM</option></select></div>';
        frag.appendChild(div);
    }
    c.innerHTML='';c.appendChild(frag);
}
function saveSchedules() {
    const saved=[];
    for(let i=0;i<3;i++){
        const s={enabled:$('sen'+i).checked,startH:+$('ssh'+i).value||6,startM:+$('ssm'+i).value||0,startPM:$('ssp'+i).value==='1',stopH:+$('stph'+i).value||7,stopM:+$('stpm'+i).value||0,stopPM:$('stpp'+i).value==='1'};
        saved.push(s);
        if(mqttClient)mqttClient.publish('home/esp8266/schedule/'+i+'/set',JSON.stringify(s));
    }
    schedData=saved;try{localStorage.setItem(LS_SCHED,JSON.stringify(saved));}catch(e){}flash('smsgSched');
}

let _panels = null, _tabs = null;
function show(n,el){
    if (!_panels) _panels = [...document.querySelectorAll('.panel')];
    if (!_tabs)   _tabs   = [...document.querySelectorAll('.tab')];
    _panels.forEach(p=>p.classList.remove('on'));
    _tabs.forEach(b=>b.classList.remove('on'));
    $('tab-'+n).classList.add('on');
    el.classList.add('on');
}
function flash(id){const e=$(id);if(!e)return;e.style.display='inline';setTimeout(()=>e.style.display='none',2000);}

// ── Init ──────────────────────────────────────────────────────
window.addEventListener('load', function () {
    cacheDOM();
    buildGrid('gFront','esp32',  1,FL);
    buildGrid('gBed',  'esp32',  6,BL);
    buildGrid('gRead', 'esp8266',1,['Fan','LED Light','Tube Light','Dim Light']);
    try{const c=localStorage.getItem(LS_SCHED);if(c){schedData=JSON.parse(c);}}catch(e){}
    renderSchedules();
    startMQTT();
});
