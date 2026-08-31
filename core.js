'use strict';

const TICKERS=['AAPL','MSFT','NVDA','AMZN','GOOGL','META','TSLA','AVGO','JPM','LLY','V','MA','COST','WMT','NFLX','AMD','QCOM','ORCL','CRM','ADP','HD','KO','PEP','XOM','UNH','MCD','BAC','C','GS','MS','BA','CAT','GE','RTX','LMT','DIS','NKE','SBUX','TGT','LOW','ABBV','MRK','PFE','TXN','MU','INTC','PANW','DE','COP','SCHW'];
const WINDOW_DAYS=10,LOOKBACK_YEARS=15,DISCOVERY_MIN_YEARS=10,DISCOVERY_MIN_WIN=70,DISCOVERY_MIN_ABS_AVG=.35;
const QUAL_MIN_YEARS=12,QUAL_MIN_WIN=75,QUAL_MIN_AVG=2,QUAL_MIN_MEDIAN=1.5,PULLBACK_MIN_ATR=.5,PULLBACK_MAX_ATR=1.5,MAX_MOVE_USED=70,MIN_RR=1.5;
const CACHE_MAX_AGE_MS=20*60*60*1000,DB_NAME='SeasonalityCalendarDB_v2',STORE_NAME='prices';

const memoryPrices=new Map(),hourlyCache=new Map(),qualificationCache=new Map(),earningsCache=new Map();
let current=new Date();current=new Date(current.getFullYear(),current.getMonth(),1);let currentSignals=[],isLoading=false,modalItem=null;
const $=id=>document.getElementById(id),pad=n=>String(n).padStart(2,'0'),ymd=d=>`${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}`,monthDay=d=>`${pad(d.getMonth()+1)}-${pad(d.getDate())}`;
const fmtShort=iso=>{const [y,m,d]=iso.split('-').map(Number);return new Date(y,m-1,d).toLocaleDateString('en-US',{month:'short',day:'numeric'})};
const pct=n=>`${n>=0?'+':''}${n.toFixed(2)}%`;

function openDb(){return new Promise((resolve,reject)=>{if(!('indexedDB'in window)){resolve(null);return}const req=indexedDB.open(DB_NAME,1);req.onupgradeneeded=()=>{const db=req.result;if(!db.objectStoreNames.contains(STORE_NAME))db.createObjectStore(STORE_NAME,{keyPath:'ticker'})};req.onsuccess=()=>resolve(req.result);req.onerror=()=>reject(req.error)})}
async function dbGet(ticker){try{const db=await openDb();if(!db)return null;return await new Promise((resolve,reject)=>{const tx=db.transaction(STORE_NAME,'readonly'),req=tx.objectStore(STORE_NAME).get(ticker);req.onsuccess=()=>resolve(req.result||null);req.onerror=()=>reject(req.error)})}catch(_){return null}}
async function dbSet(record){try{const db=await openDb();if(!db)return;await new Promise((resolve,reject)=>{const tx=db.transaction(STORE_NAME,'readwrite');tx.objectStore(STORE_NAME).put(record);tx.oncomplete=()=>resolve();tx.onerror=()=>reject(tx.error)})}catch(_){}}

function parseYahooDaily(json){
  const r=json?.chart?.result?.[0],q=r?.indicators?.quote?.[0],adj=r?.indicators?.adjclose?.[0]?.adjclose;
  if(!r||!Array.isArray(r.timestamp)||!q||!Array.isArray(adj))throw new Error('Daily price data unavailable');
  const out=[];
  for(let i=0;i<r.timestamp.length;i++){
    const a=adj[i],c=q.close?.[i],h=q.high?.[i],l=q.low?.[i],o=q.open?.[i];
    if(!Number.isFinite(a)||!Number.isFinite(c)||!Number.isFinite(h)||!Number.isFinite(l))continue;
    const dt=new Date(r.timestamp[i]*1000),iso=`${dt.getUTCFullYear()}-${pad(dt.getUTCMonth()+1)}-${pad(dt.getUTCDate())}`,factor=c?Number(a)/Number(c):1;
    out.push({d:iso,t:r.timestamp[i],a:Number(a),c:Number(c),o:Number.isFinite(o)?Number(o):Number(c),h:Number(h),l:Number(l),ah:Number(h)*factor,al:Number(l)*factor});
  }
  if(out.length<500)throw new Error('Not enough historical observations');return out;
}
function parseYahooHourly(json){
  const r=json?.chart?.result?.[0],q=r?.indicators?.quote?.[0];if(!r||!Array.isArray(r.timestamp)||!q)throw new Error('Hourly price data unavailable');
  const out=[];for(let i=0;i<r.timestamp.length;i++){const c=q.close?.[i],h=q.high?.[i],l=q.low?.[i],o=q.open?.[i];if(!Number.isFinite(c)||!Number.isFinite(h)||!Number.isFinite(l))continue;out.push({t:r.timestamp[i],c:Number(c),h:Number(h),l:Number(l),o:Number.isFinite(o)?Number(o):Number(c)})}return out;
}
async function fetchJsonProxy(target){const urls=[`https://api.allorigins.win/raw?url=${encodeURIComponent(target)}`,`https://corsproxy.io/?url=${encodeURIComponent(target)}`,`https://everyorigin.jwvbremen.nl/get?url=${encodeURIComponent(target)}`];let lastErr=null;for(const url of urls){try{const res=await fetch(url,{cache:'no-store'});if(!res.ok)throw new Error(`HTTP ${res.status}`);const text=await res.text();let data=JSON.parse(text);if(data&&typeof data.contents==='string')data=JSON.parse(data.contents);if(data&&data.contents&&typeof data.contents==='object')data=data.contents;return data}catch(e){lastErr=e}}throw lastErr||new Error('Public market-data proxy unavailable')}
async function fetchMarketHistory(ticker,start,end,interval='1d'){const qs=new URLSearchParams({period1:String(Math.floor(start)),period2:String(Math.floor(end)),interval,events:'div,splits',includeAdjustedClose:interval==='1d'?'true':'false'});let lastErr=null;for(const base of ['https://query1.finance.yahoo.com/v8/finance/chart/','https://query2.finance.yahoo.com/v8/finance/chart/']){try{const data=await fetchJsonProxy(`${base}${encodeURIComponent(ticker)}?${qs.toString()}`);if(data?.chart?.result?.[0])return data;lastErr=new Error('Historical market data unavailable')}catch(e){lastErr=e}}throw lastErr||new Error('Market data request failed')}
async function getPrices(ticker,force=false){if(memoryPrices.has(ticker)&&!force)return memoryPrices.get(ticker);if(!force){const cached=await dbGet(ticker);if(cached&&Array.isArray(cached.rows)&&Date.now()-cached.fetchedAt<CACHE_MAX_AGE_MS){memoryPrices.set(ticker,cached.rows);return cached.rows}}
  const now=new Date(),endDate=new Date(Date.UTC(now.getUTCFullYear(),now.getUTCMonth(),now.getUTCDate()+1)),startDate=new Date(Date.UTC(now.getUTCFullYear()-(LOOKBACK_YEARS+2),now.getUTCMonth(),now.getUTCDate()));
  const json=await fetchMarketHistory(ticker,Math.floor(startDate.getTime()/1000),Math.floor(endDate.getTime()/1000),'1d'),rows=parseYahooDaily(json);memoryPrices.set(ticker,rows);dbSet({ticker,rows,fetchedAt:Date.now()});return rows}
async function getHourly(ticker,force=false){if(hourlyCache.has(ticker)&&!force)return hourlyCache.get(ticker);const now=Date.now(),start=Math.floor((now-35*86400000)/1000),end=Math.floor((now+86400000)/1000),json=await fetchMarketHistory(ticker,start,end,'60m'),rows=parseYahooHourly(json);hourlyCache.set(ticker,rows);return rows}

async function fetchEarningsBatch(tickers){
  const wanted=[...new Set(tickers)].filter(Boolean),missing=wanted.filter(t=>!earningsCache.has(t));
  await pool(missing,3,async t=>{try{const target=`https://query1.finance.yahoo.com/v10/finance/quoteSummary/${encodeURIComponent(t)}?modules=calendarEvents`;const data=await fetchJsonProxy(target),raw=data?.quoteSummary?.result?.[0]?.calendarEvents?.earnings?.earningsDate?.[0],stamp=raw?.raw;let event=null;if(Number.isFinite(stamp)){const d=new Date(stamp*1000);event={date:`${d.getUTCFullYear()}-${pad(d.getUTCMonth()+1)}-${pad(d.getUTCDate())}`,time:null,name:null,source:'Yahoo Finance calendar events'}}earningsCache.set(t,{event,complete:true})}catch(_){earningsCache.set(t,{event:null,complete:false})}});
  const out={};for(const t of wanted)out[t]=earningsCache.get(t);return out;
}

function lowerBound(rows,iso){let lo=0,hi=rows.length;while(lo<hi){const mid=(lo+hi)>>1;if(rows[mid].d<iso)lo=mid+1;else hi=mid}return lo}
function addDaysIso(iso,days){const[y,m,d]=iso.split('-').map(Number),x=new Date(Date.UTC(y,m-1,d));x.setUTCDate(x.getUTCDate()+days);return`${x.getUTCFullYear()}-${pad(x.getUTCMonth()+1)}-${pad(x.getUTCDate())}`}
const mean=arr=>arr.reduce((a,b)=>a+b,0)/arr.length;
function median(arr){const a=[...arr].sort((x,y)=>x-y),n=a.length;return n%2?a[(n-1)/2]:(a[n/2-1]+a[n/2])/2}
function sma(values,n,endIndex=values.length-1){if(endIndex-n+1<0)return null;let s=0;for(let i=endIndex-n+1;i<=endIndex;i++)s+=values[i];return s/n}
function ema(values,n){if(values.length<n)return null;const k=2/(n+1);let e=mean(values.slice(0,n));for(let i=n;i<values.length;i++)e=values[i]*k+e*(1-k);return e}
function wilderAtr(rows,n=14){if(rows.length<n+1)return null;const tr=[];for(let i=1;i<rows.length;i++){const prev=rows[i-1].a,h=rows[i].ah,l=rows[i].al;tr.push(Math.max(h-l,Math.abs(h-prev),Math.abs(l-prev)))}if(tr.length<n)return null;let a=mean(tr.slice(0,n));for(let i=n;i<tr.length;i++)a=(a*(n-1)+tr[i])/n;return a}

function calculateSignalForDate(rows,displayDate){
  const targetMD=monthDay(displayDate),thisYear=(new Date()).getFullYear(),observations=[];
  for(let year=thisYear-LOOKBACK_YEARS;year<=thisYear-1;year++){
    const target=`${year}-${targetMD}`,idx=lowerBound(rows,target);if(idx>=rows.length)continue;const start=rows[idx];if(start.d>addDaysIso(target,7))continue;const endIdx=idx+WINDOW_DAYS;if(endIdx>=rows.length)continue;const end=rows[endIdx],span=(new Date(end.d+'T00:00:00Z')-new Date(start.d+'T00:00:00Z'))/86400000;if(span>23)continue;const ret=(end.a/start.a-1)*100;if(Number.isFinite(ret))observations.push({year,ret,start:start.d,end:end.d})
  }
  if(observations.length<DISCOVERY_MIN_YEARS)return null;const positives=observations.filter(x=>x.ret>0).length,negatives=observations.filter(x=>x.ret<0).length,bullRate=100*positives/observations.length,bearRate=100*negatives/observations.length,dir=bullRate>=bearRate?'up':'down',win=dir==='up'?bullRate:bearRate,avg=mean(observations.map(x=>x.ret)),med=median(observations.map(x=>x.ret));
  if(win<DISCOVERY_MIN_WIN||Math.abs(avg)<DISCOVERY_MIN_ABS_AVG||(dir==='up'&&avg<=0)||(dir==='down'&&avg>=0))return null;return{dir,win,avg,median:med,years:observations.length,rows:observations}
}

function nthWeekday(year,monthIndex,weekday,n){const d=new Date(year,monthIndex,1),delta=(7+weekday-d.getDay())%7;d.setDate(1+delta+7*(n-1));return d}function lastWeekday(year,monthIndex,weekday){const d=new Date(year,monthIndex+1,0),delta=(7+d.getDay()-weekday)%7;d.setDate(d.getDate()-delta);return d}
function easterSunday(year){const a=year%19,b=Math.floor(year/100),c=year%100,d=Math.floor(b/4),e=b%4,f=Math.floor((b+8)/25),g=Math.floor((b-f+1)/3),h=(19*a+b-d-g+15)%30,i=Math.floor(c/4),k=c%4,l=(32+2*e+2*i-h-k)%7,m=Math.floor((a+11*h+22*l)/451),month=Math.floor((h+l-7*m+114)/31)-1,day=((h+l-7*m+114)%31)+1;return new Date(year,month,day)}
function observedFixed(year,monthIndex,day){const d=new Date(year,monthIndex,day);if(d.getDay()===6)d.setDate(d.getDate()-1);if(d.getDay()===0)d.setDate(d.getDate()+1);return d}
function holidaySet(year){const dates=[observedFixed(year,0,1),nthWeekday(year,0,1,3),nthWeekday(year,1,1,3)];const easter=easterSunday(year),gf=new Date(easter);gf.setDate(easter.getDate()-2);dates.push(gf,lastWeekday(year,4,1));if(year>=2022)dates.push(observedFixed(year,5,19));dates.push(observedFixed(year,6,4),nthWeekday(year,8,1,1),nthWeekday(year,10,4,4),observedFixed(year,11,25));return new Set(dates.map(ymd))}
const holidayMemo=new Map();function isMarketDay(d){if(d.getDay()===0||d.getDay()===6)return false;const y=d.getFullYear();if(!holidayMemo.has(y))holidayMemo.set(y,holidaySet(y));return!holidayMemo.get(y).has(ymd(d))}function nextMarketDay(d){const x=new Date(d);do{x.setDate(x.getDate()+1)}while(!isMarketDay(x));return x}function projectedEnd(startDate){let x=new Date(startDate),count=0;while(count<WINDOW_DAYS){x=nextMarketDay(x);count++}return x}function addMarketDays(start,n){let x=new Date(start),count=0;while(count<n){x.setDate(x.getDate()+1);if(isMarketDay(x))count++}return x}
function marketDaysUntil(from,toIso){const[y,m,d]=toIso.split('-').map(Number),target=new Date(y,m-1,d),x=new Date(from.getFullYear(),from.getMonth(),from.getDate());if(target<x)return-1;let count=0,cur=new Date(x);while(cur<target&&count<30){cur.setDate(cur.getDate()+1);if(isMarketDay(cur))count++}return cur.getTime()===target.getTime()?count:99}

function signalStrength(s){return s.win+Math.min(Math.abs(s.avg),8)*1.5+Math.min(s.years,15)*.08}
function tradingDatesInMonth(date){const y=date.getFullYear(),m=date.getMonth(),out=[],days=new Date(y,m+1,0).getDate();for(let day=1;day<=days;day++){const d=new Date(y,m,day);if(isMarketDay(d))out.push(d)}return out}
function sparsifyTickerSignals(raw){const kept=[];for(let i=0;i<raw.length;i++){const cur=raw[i],neighborhood=[...raw.slice(Math.max(0,i-2),i),...raw.slice(i+1,i+3)].filter(x=>x.signal&&x.signal.dir===cur.signal.dir),score=signalStrength(cur.signal);if(!neighborhood.some(x=>signalStrength(x.signal)>score+.05))kept.push(cur)}const result=[];for(const item of kept){const last=result[result.length-1];if(last&&last.ticker===item.ticker&&last.signal.dir===item.signal.dir){const diff=(item.date-last.date)/86400000;if(diff<=4){if(signalStrength(item.signal)>signalStrength(last.signal))result[result.length-1]=item;continue}}result.push(item)}return result}
async function pool(items,limit,worker){let next=0;const runners=Array.from({length:Math.min(limit,items.length)},async()=>{while(true){const i=next++;if(i>=items.length)break;await worker(items[i],i)}});await Promise.all(runners)}

function nyDateAndMinutes(){const parts=new Intl.DateTimeFormat('en-US',{timeZone:'America/New_York',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hour12:false}).formatToParts(new Date()),o={};for(const p of parts)o[p.type]=p.value;return{iso:`${o.year}-${o.month}-${o.day}`,minutes:Number(o.hour)*60+Number(o.minute)}}
function completedDailyRows(rows){const ny=nyDateAndMinutes(),out=[...rows];if(out.length&&out[out.length-1].d===ny.iso&&ny.minutes<16*60+10)out.pop();return out}
function completedHourlyRows(rows){const cutoff=Math.floor((Date.now()-5*60000)/1000);return rows.filter(r=>r.t+3600<=cutoff)}

function dailyMetrics(rows,dir){
  const r=completedDailyRows(rows);if(r.length<70)return{ok:false,reason:'Not enough completed Daily bars'};const closes=r.map(x=>x.a),last=r[r.length-1],sma50Now=sma(closes,50),sma50Then=sma(closes,50,closes.length-11),ema20Now=ema(closes,20),atr=wilderAtr(r,14);if(!Number.isFinite(sma50Now)||!Number.isFinite(sma50Then)||!Number.isFinite(ema20Now)||!Number.isFinite(atr)||atr<=0)return{ok:false,reason:'Daily indicators unavailable'};
  const trend=dir==='up'?(last.a>sma50Now&&ema20Now>sma50Now&&sma50Now>sma50Then):(last.a<sma50Now&&ema20Now<sma50Now&&sma50Now<sma50Then);
  const last10=r.slice(-10),recentHigh=Math.max(...last10.map(x=>x.ah)),recentLow=Math.min(...last10.map(x=>x.al)),pullbackAtr=dir==='up'?(recentHigh-last.a)/atr:(last.a-recentLow)/atr,pullback=pullbackAtr>=PULLBACK_MIN_ATR&&pullbackAtr<=PULLBACK_MAX_ATR;
  const last5=r.slice(-5),stop=dir==='up'?Math.min(...last5.map(x=>x.al))-.25*atr:Math.max(...last5.map(x=>x.ah))+.25*atr;
  return{ok:true,lastClose:last.a,trend,sma50:sma50Now,ema20:ema20Now,atr,pullbackAtr,pullback,stop,lastDate:last.d};
}
function hourlyMetrics(rows,dir){const r=completedHourlyRows(rows);if(r.length<25)return{ok:false,reason:'Not enough completed 1H bars'};const last=r[r.length-1],prev3=r.slice(-4,-1),ema20Now=ema(r.map(x=>x.c),20),trigger=dir==='up'?(last.c>Math.max(...prev3.map(x=>x.h))&&last.c>ema20Now):(last.c<Math.min(...prev3.map(x=>x.l))&&last.c<ema20Now);return{ok:true,entry:last.c,ema20:ema20Now,trigger,lastTime:last.t}}
function realizedSeasonMove(rows,item,dailyLastClose){const startIso=ymd(item.date),idx=lowerBound(rows,startIso);if(idx>=rows.length)return 0;const start=rows[idx];if(start.d>addDaysIso(startIso,7))return 0;const raw=(dailyLastClose/start.a-1)*100;return item.signal.dir==='up'?raw:-raw}
function seasonalGate(item){const s=item.signal,dirSign=s.dir==='up'?1:-1;return{pass:s.win>=QUAL_MIN_WIN&&s.years>=QUAL_MIN_YEARS&&Math.abs(s.avg)>=QUAL_MIN_AVG&&s.median*dirSign>=QUAL_MIN_MEDIAN,details:`${Math.round(s.win)}% · ${s.years}y · avg ${pct(s.avg)} · med ${pct(s.median)}`}}