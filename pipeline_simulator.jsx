import React, { useEffect, useMemo, useRef, useState } from "react";

// ------------------------------------------------------------
// Pipeline Simulator — Single-file React app (drag + 3D lift)
// - NEW: Drag nodes inside the left SVG panel; movement clamped to viewBox (0..100)
// - NEW: Subtle 3D elevation (SVG drop-shadow), stronger while dragging/selected
// - High-contrast colors + hardened RNG + diagnostics remain
// ------------------------------------------------------------

// =============================
// SAFE DETERMINISTIC PRNG
// =============================
function makeRng(seedInput: number | null | undefined) {
  let t = Number.isFinite(seedInput as number)
    ? (Math.floor(seedInput as number) >>> 0)
    : 0x9e3779b9;
  if (t === 0) t = 0x9e3779b9;
  return function rng(): number {
    t += 0x6D2B79F5;
    let r = Math.imul(t ^ (t >>> 15), 1 | t);
    r ^= r + Math.imul(r ^ (r >>> 7), 61 | r);
    const out = ((r ^ (r >>> 14)) >>> 0) / 4294967296;
    if (!Number.isFinite(out) || out < 0 || out >= 1) {
      const fallback = Math.random();
      return Number.isFinite(fallback) && fallback < 1 ? fallback : 0.5;
    }
    return out;
  };
}

// =============================
// TYPES
// =============================
 type NodeType = "broker"|"topic"|"processor"|"lib"|"api"|"service"|"db"|"source"|"client";
 export type Node = { id:number; name:string; type:NodeType; x:number; y:number };
 type Edge = { id:number; from:number; to:number; label?:string };
 type MessageType = "ChartData"|"Event"|"DataField";
 type Message = { id:string; type:MessageType; ts:number; payload:any; edgeId:number; progress:number };
 type SqlRow = { id:string; symbol:string; value:number; ts:number };

// =============================
// VIEW CONSTANTS (explicit HEX for SVG)
// =============================
const NODE_STYLE: Record<NodeType, {fill:string; stroke:string; text:string}> = {
  broker:   { fill: "#fde68a", stroke: "#d97706", text: "#111827" }, // amber-200 / orange-600
  topic:    { fill: "#bae6fd", stroke: "#0284c7", text: "#0f172a" }, // sky-200 / sky-600
  processor:{ fill: "#cbd5e1", stroke: "#475569", text: "#0f172a" }, // slate-300 / slate-600
  lib:      { fill: "#fef3c7", stroke: "#f59e0b", text: "#0f172a" }, // amber-100 / amber-500
  api:      { fill: "#d9f99d", stroke: "#65a30d", text: "#0f172a" }, // lime-200 / lime-600
  service:  { fill: "#fecaca", stroke: "#f43f5e", text: "#0f172a" }, // rose-200 / rose-500
  db:       { fill: "#fbcfe8", stroke: "#f472b6", text: "#0f172a" }, // pink-200 / pink-500
  source:   { fill: "#e9d5ff", stroke: "#8b5cf6", text: "#0f172a" }, // purple-200 / violet-600
  client:   { fill: "#f1f5f9", stroke: "#94a3b8", text: "#0f172a" }  // slate-100 / slate-400
};

// Base layout approximating the provided diagram (0..100 grid)
const BASE_NODES: Node[] = [
  { id:12, name:"Hub (Kafka)", type:"broker", x:20, y:20 },
  { id:13, name:"ChartData <Kafka>", type:"topic", x:8, y:8 },
  { id:10, name:"Module Realtime (Calculator)", type:"processor", x:40, y:20 },
  { id:9, name:"Library Calculator", type:"lib", x:36, y:35 },
  { id:8, name:"Library Core", type:"lib", x:32, y:50 },
  { id:11, name:"API (.NET Core, mocked)", type:"api", x:16, y:40 },
  { id:4, name:"Event Service", type:"service", x:68, y:70 },
  { id:5, name:"DataField API", type:"api", x:86, y:70 },
  { id:2, name:"SQL (in-memory)", type:"db", x:60, y:70 },
  { id:6, name:"RabbitMQ Data", type:"broker", x:92, y:30 },
  { id:101, name:"Data Services (pub/sub & stream)", type:"service", x:84, y:18 },
  { id:1, name:"Data Ingest (JSON)", type:"source", x:68, y:90 },
  { id:0, name:"Client UI", type:"client", x:8, y:30 }
];

const EDGES: Edge[] = [
  { id:1, from:1, to:4, label:"raw JSON" },
  { id:2, from:4, to:5, label:"events" },
  { id:3, from:5, to:2, label:"3) Cast JSON → SQL DAO" },
  { id:4, from:12, to:10, label:"pub/stream" },
  { id:5, from:10, to:9, label:"calc uses" },
  { id:6, from:9, to:8, label:"core lib" },
  { id:7, from:11, to:12, label:"produce" },
  { id:8, from:12, to:13, label:"topic ChartData" },
  { id:9, from:13, to:0, label:"subscribe" },
  { id:10, from:101, to:6, label:"flow → RabbitMQ" },
  { id:11, from:101, to:12, label:"pub/sub bridge" }
];

// --- dynamic node registry used by helpers (keeps tests unchanged)
let currentNodes: Node[] = BASE_NODES.map(n=>({...n}));
const nodeById = (id:number)=>currentNodes.find(n=>n.id===id)!;
const edgeById = (id:number)=>EDGES.find(e=>e.id===id)!;

function pathForEdge(edge:Edge){
  const a = nodeById(edge.from); const b = nodeById(edge.to);
  const x1=a.x, y1=a.y, x2=b.x, y2=b.y; const cx=(x1+x2)/2, cy=(y1+y2)/2 + (x2-x1)*0.08; // slight curve
  return {x1,y1,x2,y2,cx,cy};
}

function pointOnQuad(t:number, p:{x1:number,y1:number,x2:number,y2:number,cx:number,cy:number}){
  const x = (1-t)*(1-t)*p.x1 + 2*(1-t)*t*p.cx + t*t*p.x2;
  const y = (1-t)*(1-t)*p.y1 + 2*(1-t)*t*p.cy + t*t*p.y2;
  return {x,y};
}

// =============================
// PURE MAP/CAST HELPERS (also used by tests)
// =============================
function mapEventToDataField(payload:any){
  return {
    field: payload?.field ?? "value",
    symbol: String((payload?.device ?? "DEV")).toUpperCase(),
    value: Number(payload?.value ?? 0),
    ts: Date.now()
  };
}
function rowFromDataField(df:any): SqlRow {
  return {
    id: df?.id || `row-${Math.random().toString(36).slice(2)}`,
    symbol: String(df?.symbol ?? "DF"),
    value: Number(df?.value ?? 0),
    ts: Number(df?.ts ?? Date.now())
  };
}

// =============================
// MAIN COMPONENT
// =============================
export default function PipelineSimulator(){
  // Simulation controls
  const [running, setRunning] = useState(true);
  const [speed, setSpeed] = useState(1); // 0.2x..2x
  const [seed, setSeed] = useState(42);
  const rng = useMemo(()=>makeRng(seed),[seed]);
  const [tickMs, setTickMs] = useState(800);

  // Nodes become stateful for dragging
  const [nodes, setNodes] = useState<Node[]>(BASE_NODES.map(n=>({...n})));
  currentNodes = nodes; // update registry for helpers
  const [selectedNode, setSelectedNode] = useState<number|undefined>(undefined);

  // Drag state
  const [drag, setDrag] = useState<null | { id:number; dx:number; dy:number }>(null);
  const NODE_W = 16, NODE_H = 8; // drawing size in viewBox units

  // Messages flying along edges
  const [msgs, setMsgs] = useState<Message[]>([]);

  // Logs
  type Log = { t:number; node:number; text:string; type:MessageType };
  const [logs, setLogs] = useState<Log[]>([]);
  const addLog = (node:number, text:string, type:MessageType)=>
    setLogs(L=>{ const entry={ t:Date.now(), node, text, type }; return [...L.slice(-400), entry]; });

  // SQL table
  const [rows, setRows] = useState<SqlRow[]>([]);
  const [sqlFilter, setSqlFilter] = useState("");

  // ChartData stream buffer
  const [chartPoints, setChartPoints] = useState<{t:number, v:number}[]>([]);
  const lastPoint = (arr:{t:number,v:number}[]) => arr.length ? arr[arr.length-1] : undefined;

  // --- Producers ---
  function spawnApiToKafka(){
    const prev = lastPoint(chartPoints)?.v ?? 50;
    const value = 50 + (rng()*20-10) + prev*0.1; // slight trend
    const payload = { symbol:"AAA", value: Number(value.toFixed(2)) };
    const m: Message = { id: `cd-${Date.now()}-${Math.floor(rng()*1e6)}`, type:"ChartData", ts: Date.now(), payload, edgeId:7, progress:0 };
    setMsgs(M=>[...M, m]);
  }

  function spawnIngestToEvent(){
    const payload = { device:"sensor-"+Math.floor(rng()*10), field:"temp", value: +(20 + rng()*10).toFixed(2) };
    const m: Message = { id: `ev-${Date.now()}-${Math.floor(rng()*1e6)}`, type:"Event", ts: Date.now(), payload, edgeId:1, progress:0 };
    setMsgs(M=>[...M, m]);
  }

  // --- Router when a message reaches an edge's 'to' node ---
  function deliver(msg: Message, toNode:number){
    const n = nodes.find(nn=>nn.id===toNode)!;

    if (n.id===4){
      const cast = mapEventToDataField(msg.payload);
      addLog(n.id, `Mapped to DataField {symbol:${cast.symbol}, value:${cast.value}}`, "DataField");
      const next: Message = { id: msg.id+"-df", type:"DataField", ts: Date.now(), payload: cast, edgeId:2, progress:0 };
      setMsgs(M=>[...M, next]);
    }
    else if (n.id===5){
      const row = rowFromDataField(msg.payload);
      setRows(R=>[...R.slice(-999), row]);
      addLog(n.id, `DAO cast ready for SQL (symbol=${row.symbol}, value=${row.value})`, msg.type);
      const next: Message = { id: msg.id+"-sql", type:"DataField", ts: Date.now(), payload: row, edgeId:3, progress:0 };
      setMsgs(M=>[...M, next]);
    }
    else if (n.id===2){
      addLog(n.id, `INSERT rows=${rows.length+1}`, msg.type);
    }
    else if (n.id===12){
      addLog(n.id, `Hub received ${msg.type}`, msg.type);
      const toModule: Message = { ...msg, id: msg.id+"-mod", edgeId:4, progress:0 };
      const toTopic: Message = { ...msg, id: msg.id+"-topic", edgeId:8, progress:0 };
      setMsgs(M=>[...M, toModule, toTopic]);
    }
    else if (n.id===10){
      const last = lastPoint(chartPoints)?.v ?? 50;
      const v = (0.7*last + 0.3*(msg.payload?.value ?? last));
      const payload = { ...msg.payload, value:+v.toFixed(2), ma:true };
      addLog(n.id, `Realtime calc → ${payload.value}`, msg.type);
      const next: Message = { id: msg.id+"-lib1", type: msg.type, ts: Date.now(), payload, edgeId:5, progress:0 };
      setMsgs(M=>[...M, next]);
    }
    else if (n.id===9){
      const next: Message = { id: msg.id+"-lib2", type: msg.type, ts: Date.now(), payload: msg.payload, edgeId:6, progress:0 };
      setMsgs(M=>[...M, next]);
    }
    else if (n.id===8){
      addLog(n.id, `Core lib ok`, msg.type);
    }
    else if (n.id===13){
      const next: Message = { id: msg.id+"-cli", type: msg.type, ts: Date.now(), payload: msg.payload, edgeId:9, progress:0 };
      setMsgs(M=>[...M, next]);
    }
    else if (n.id===0){
      const v = Number(msg.payload?.value)||0; const t = Date.now();
      setChartPoints(P=>[...P.slice(-180), { t, v }]);
      addLog(n.id, `UI received ${v}`, msg.type);
    }
  }

  // --- Simulation Loop (RAF) ---
  useEffect(()=>{
    let raf:number; let last=performance.now();
    const loop = (now:number)=>{
      const dt = (now-last); last=now;
      if (running){
        setMsgs(current=> current.map(m=> ({...m, progress: Math.min(1, m.progress + (dt/(tickMs/Math.max(0.1,speed))))})));
        if (now % Math.max(250, tickMs*0.8) < dt) spawnApiToKafka();
        if (now % Math.max(1000, tickMs*2) < dt) spawnIngestToEvent();
      }
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return ()=>cancelAnimationFrame(raf);
  }, [running, speed, tickMs, seed]);

  // When messages finish an edge, deliver to the 'to' node and remove the msg
  useEffect(()=>{
    if (!msgs.length) return;
    const finished = msgs.filter(m=>m.progress>=1);
    if (finished.length){
      finished.forEach(m=> deliver(m, edgeById(m.edgeId).to));
      setMsgs(M=> M.filter(m=>m.progress<1));
    }
  }, [msgs]);

  // --- Derived: compute per-node TPS from logs (last 6 seconds)
  const tpsByNode = useMemo(()=>{
    const win = 6000; const cutoff = Date.now()-win;
    const counts: Record<number, number> = {};
    for (const n of nodes) counts[n.id]=0;
    for (const l of logs) if (l.t>=cutoff) counts[l.node] = (counts[l.node]||0)+1;
    const tps: Record<number, number> = {};
    for (const n of nodes) tps[n.id] = counts[n.id]/(win/1000);
    return tps;
  }, [logs, nodes]);

  // --- Dragging helpers ---
  const svgRef = useRef<SVGSVGElement>(null);
  const clamp = (val:number,min:number,max:number)=> Math.max(min, Math.min(max, val));
  const toViewBox = (e: React.PointerEvent): {x:number;y:number} => {
    const svg = svgRef.current!;
    const rect = svg.getBoundingClientRect();
    const x = ((e.clientX - rect.left) / rect.width) * 100;
    const y = ((e.clientY - rect.top) / rect.height) * 100;
    return { x, y };
  };

  const onNodePointerDown = (e: React.PointerEvent, id:number)=>{
    e.stopPropagation();
    const p = toViewBox(e);
    const n = nodes.find(nn=>nn.id===id)!;
    setSelectedNode(id);
    setDrag({ id, dx: p.x - n.x, dy: p.y - n.y });
    svgRef.current?.setPointerCapture?.(e.pointerId);
  };

  const onSvgPointerMove = (e: React.PointerEvent)=>{
    if (!drag) return;
    const p = toViewBox(e);
    setNodes(ns => ns.map(n => n.id!==drag.id ? n : ({
      ...n,
      x: clamp(p.x - drag.dx, NODE_W/2, 100 - NODE_W/2),
      y: clamp(p.y - drag.dy, NODE_H/2, 100 - NODE_H/2)
    })));
  };
  const onSvgPointerUp = (e: React.PointerEvent)=>{
    if (drag) svgRef.current?.releasePointerCapture?.(e.pointerId);
    setDrag(null);
  };

  // Order nodes so dragging one renders on top
  const orderedNodes = useMemo(()=>{
    if (!drag) return nodes;
    return [...nodes.filter(n=>n.id!==drag.id), nodes.find(n=>n.id===drag.id)!];
  }, [nodes, drag]);

  // --- Minimal Charts (SVG) ---
  function MiniLineChart({ data }:{ data:{t:number,v:number}[] }){
    const W=320, H=120, P=20;
    if (!data || data.length<2) return <div className="text-xs text-gray-500">No data yet…</div>;
    const t0=data[0].t, t1=data[data.length-1].t; const x=(t:number)=>P+(W-2*P)*(t-t0)/(t1-t0||1);
    const vs=data.map(d=>d.v); const vmin=Math.min(...vs), vmax=Math.max(...vs);
    const y=(v:number)=>H-P - (H-2*P)*((v-vmin)/(vmax-vmin||1));
    const d = data.map((p,i)=>`${i?'L':'M'}${x(p.t)},${y(p.v)}`).join(" ");
    return (
      <svg width={W} height={H} className="border rounded">
        <path d={d} fill="none" strokeWidth={2} stroke="#0ea5e9" />
        <text x={4} y={12} style={{fontSize:10, fill:'#475569'}}> {vmin.toFixed(2)}–{vmax.toFixed(2)} </text>
      </svg>
    );
  }

  function MiniBarChart({ series }:{ series:[string,number][] }){
    const W=320, H=120, P=20, bar=16, gap=4; const max=Math.max(1,...series.map(s=>s[1]||0));
    return (
      <svg width={W} height={H} className="border rounded">
        {series.map(([name,val],i)=>{
          const x=P+i*(bar+gap), h=(H-2*P)*((val||0)/max), y=H-P-h;
          return (
            <g key={name}>
              <rect x={x} y={y} width={bar} height={h} fill="#a78bfa" />
              <text x={x+bar/2} y={H-4} textAnchor="middle" style={{fontSize:9, fill:'#334155'}}>{name}</text>
            </g>
          );
        })}
      </svg>
    );
  }

  // --- Diagnostics / Self-tests ---
  type T = { name:string; pass:boolean; detail:string };
  function runSelfTests(): T[] {
    const tests: T[] = [];
    try { const local = makeRng(seed); const arr = Array.from({length:10}, ()=>local()); const ok = arr.every(x=> typeof x === 'number' && Number.isFinite(x) && x>=0 && x<1); tests.push({ name:"RNG returns finite [0,1)", pass: ok, detail: ok?`min=${Math.min(...arr).toFixed(3)} max=${Math.max(...arr).toFixed(3)}`: `bad=${arr}` }); } catch (e:any) { tests.push({ name:"RNG throws", pass:false, detail:String(e) }); }
    try{ const p = pathForEdge(EDGES[0]); const ok = [p.x1,p.y1,p.x2,p.y2,p.cx,p.cy].every(n=>Number.isFinite(n)); tests.push({ name:"Edge path numbers", pass: ok, detail: JSON.stringify(p) }); } catch(e:any){ tests.push({ name:"Edge path numbers", pass:false, detail:String(e)}); }
    try{ const df = mapEventToDataField({device:"sensor-1", field:"temp", value:25}); const row = rowFromDataField(df); const ok = df.symbol === 'SENSOR-1' && row.symbol === 'SENSOR-1' && row.value === 25; tests.push({ name:"Event→DataField→Row", pass: ok, detail: ok?"OK":"Mismatch" }); } catch(e:any){ tests.push({ name:"Event→DataField→Row", pass:false, detail:String(e)}); }
    return tests;
  }
  const [tests, setTests] = useState<T[] | null>(null);

  // --- Render ---
  return (
    <div className="w-full h-full flex flex-col gap-2 p-3 text-sm">
      {/* Header / Toolbar */}
      <div className="flex items-center gap-2">
        <h1 className="text-lg font-semibold">Pipeline Simulator</h1>
        <div className="flex items-center gap-2 ml-auto">
          <button className="px-3 py-1 rounded bg-black text-white" onClick={()=>setRunning(r=>!r)}>{running?"Pause":"Play"}</button>
          <button className="px-3 py-1 rounded border" onClick={()=>{setMsgs(M=>M.map(m=>({...m, progress:1})));}}>Step</button>
          <label className="flex items-center gap-1">Speed
            <input aria-label="speed" type="range" min={0.2} max={2} step={0.1} value={speed} onChange={e=>setSpeed(parseFloat(e.target.value))} />
          </label>
          <label className="flex items-center gap-1">Tick
            <input aria-label="tick" type="number" className="w-16 border rounded px-1" value={tickMs} onChange={e=>setTickMs(Math.max(100, parseInt(e.target.value||"800")))} /> ms
          </label>
          <label className="flex items-center gap-1">Seed
            <input aria-label="seed" type="number" className="w-16 border rounded px-1" value={seed} onChange={e=>setSeed(parseInt(e.target.value||"42"))} />
          </label>
          <button className="px-3 py-1 rounded border" onClick={()=>{setMsgs([]); setRows([]); setChartPoints([]); setLogs([]);}}>Reset</button>
          <button className="px-3 py-1 rounded border" onClick={()=>setTests(runSelfTests())}>Run tests</button>
        </div>
      </div>

      {/* Actions */}
      <div className="flex gap-2">
        <button className="px-3 py-1 rounded bg-blue-600 text-white" onClick={spawnApiToKafka}>Publish → Kafka (ChartData)</button>
        <button className="px-3 py-1 rounded bg-emerald-600 text-white" onClick={spawnIngestToEvent}>Send JSON → Event Service</button>
      </div>

      {/* Main layout: Graph / Panels */}
      <div className="grid grid-cols-12 gap-3 flex-1 min-h-[420px]">
        {/* Graph */}
        <div className="col-span-7 relative border rounded bg-white">
          <svg
            ref={svgRef}
            viewBox="0 0 100 100"
            preserveAspectRatio="none"
            className="absolute inset-0 w-full h-full"
            onPointerMove={onSvgPointerMove}
            onPointerUp={onSvgPointerUp}
            onPointerLeave={onSvgPointerUp}
          >
            <defs>
              <marker id="arrow" viewBox="0 0 10 10" refX="7" refY="5" markerWidth="4" markerHeight="4" orient="auto-start-reverse">
                <path d="M 0 0 L 10 5 L 0 10 z" fill="#94a3b8" />
              </marker>
              {/* Subtle elevation shadows */}
              <filter id="elev" x="-20%" y="-20%" width="140%" height="140%">
                <feDropShadow dx="0" dy="0.6" stdDeviation="0.5" floodOpacity="0.35" />
              </filter>
              <filter id="elevHi" x="-30%" y="-30%" width="160%" height="160%">
                <feDropShadow dx="0" dy="1.4" stdDeviation="1.1" floodOpacity="0.45" />
              </filter>
            </defs>

            {/* Edges */}
            {EDGES.map(e=>{
              const p = pathForEdge(e);
              return (
                <g key={e.id}>
                  <path d={`M ${p.x1} ${p.y1} Q ${p.cx} ${p.cy} ${p.x2} ${p.y2}`} fill="none" stroke="#94a3b8" strokeWidth={0.5} markerEnd="url(#arrow)"/>
                  {e.label && (
                    <text x={(p.x1+p.x2)/2} y={(p.y1+p.y2)/2} style={{ fontSize: 2.4, fill:'#334155' }}>{e.label}</text>
                  )}
                </g>
              );
            })}

            {/* Messages (animated dots) */}
            {msgs.map(m=>{
              const p = pathForEdge(edgeById(m.edgeId));
              const pt = pointOnQuad(m.progress, p);
              const fill = m.type==="ChartData"?"#0284c7": m.type==="Event"?"#10b981":"#f59e0b";
              return <circle key={m.id} cx={pt.x} cy={pt.y} r={1.2} fill={fill} />;
            })}

            {/* Nodes (draggable) */}
            {orderedNodes.map(n=>{
              const w=NODE_W,h=NODE_H; const s = NODE_STYLE[n.type];
              const active = drag?.id===n.id || selectedNode===n.id;
              const filter = active?"url(#elevHi)":"url(#elev)";
              return (
                <g key={n.id}
                   onPointerDown={(e)=>onNodePointerDown(e,n.id)}
                   onClick={(e)=>{ e.stopPropagation(); setSelectedNode(n.id); }}
                   style={{ cursor: drag?.id===n.id?"grabbing":"grab" }}
                >
                  <rect x={n.x-w/2} y={n.y-h/2} width={w} height={h} rx={1.6} fill={s.fill} stroke={s.stroke} strokeWidth={0.8} filter={filter} />
                  <text x={n.x} y={n.y} textAnchor="middle" alignmentBaseline="middle" style={{ fontSize: 2.6, fill: s.text }}>
                    {n.name}
                  </text>
                </g>
              );
            })}
          </svg>
        </div>

        {/* Right panels */}
        <div className="col-span-5 flex flex-col gap-3">
          {/* Inspector */}
          <div className="border rounded p-2">
            <div className="font-medium mb-1">Inspector</div>
            {selectedNode==null ? (
              <div className="text-gray-500">Click a node on the graph to inspect. Drag to reposition.</div>
            ) : (
              <div>
                {(()=>{ const n=nodes.find(nn=>nn.id===selectedNode)!; return (
                  <div>
                    <div className="text-sm font-semibold">{n.name}</div>
                    <div className="text-xs text-gray-600">Type: {n.type}</div>
                    <div className="text-xs">Throughput: {tpsByNode[n.id]?.toFixed(2) ?? "0.00"} msg/s</div>
                    <div className="text-xs">Position: ({n.x.toFixed(1)}, {n.y.toFixed(1)})</div>
                    <div className="mt-2 text-xs font-medium">Last 5 logs</div>
                    <ul className="text-xs max-h-24 overflow-auto list-disc pl-4">
                      {logs.filter(l=>l.node===n.id).slice(-5).reverse().map((l,i)=>(
                        <li key={i}><span className="text-gray-500">{new Date(l.t).toLocaleTimeString()}</span> — {l.text}</li>
                      ))}
                    </ul>
                  </div>
                ); })()}
              </div>
            )}
          </div>

          {/* SQL */}
          <div className="border rounded p-2">
            <div className="flex items-center justify-between mb-1">
              <div className="font-medium">SQL (in-memory)</div>
              <div className="flex gap-2 items-center">
                <input value={sqlFilter} onChange={e=>setSqlFilter(e.target.value)} placeholder="filter symbol…" className="border rounded px-2 py-0.5 text-xs" />
                <button className="px-2 py-0.5 rounded border" onClick={()=>setRows([])}>CLEAR</button>
              </div>
            </div>
            <div className="max-h-36 overflow-auto">
              <table className="w-full text-xs">
                <thead className="sticky top-0 bg-white">
                  <tr className="text-left"> <th className="p-1">ts</th> <th>symbol</th> <th>value</th> </tr>
                </thead>
                <tbody>
                  {rows.filter(r=>!sqlFilter || r.symbol.toLowerCase().includes(sqlFilter.toLowerCase())).slice(-200).reverse().map(r=> (
                    <tr key={r.id} className="odd:bg-gray-50">
                      <td className="p-1">{new Date(r.ts).toLocaleTimeString()}</td>
                      <td>{r.symbol}</td>
                      <td>{r.value}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          {/* Charts */}
          <div className="border rounded p-2">
            <div className="font-medium mb-2">Charts</div>
            <div className="grid grid-cols-1 gap-2">
              <div>
                <div className="text-xs text-gray-600 mb-1">ChartData (line)</div>
                <MiniLineChart data={chartPoints} />
              </div>
              <div>
                <div className="text-xs text-gray-600 mb-1">Per-node TPS (bar)</div>
                <MiniBarChart series={nodes.map(n=>[String(n.id), tpsByNode[n.id]||0] as [string,number])} />
              </div>
            </div>
          </div>

          {/* Logs */}
          <div className="border rounded p-2">
            <div className="font-medium mb-1">Logs</div>
            <div className="h-28 overflow-auto text-xs font-mono leading-tight">
              {logs.slice(-200).reverse().map((l,i)=> (
                <div key={i}>[{new Date(l.t).toLocaleTimeString()}] (node:{l.node}) {l.type}: {l.text}</div>
              ))}
            </div>
          </div>

          {/* Diagnostics */}
          {tests && (
            <div className="border rounded p-2">
              <div className="font-medium mb-1">Diagnostics</div>
              <ul className="text-xs list-disc pl-4">
                {tests.map((t,i)=> (
                  <li key={i} className={t.pass?"text-emerald-700":"text-red-600"}>
                    {t.pass ? "✓" : "✗"} {t.name} — <span className="text-gray-600">{t.detail}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      </div>

      {/* Footer hint */}
      <div className="text-[11px] text-gray-500">Drag any node to reposition it. Movement is clamped to the left panel. Nodes pop with a 3D drop-shadow when selected or dragging.</div>
    </div>
  );
}
