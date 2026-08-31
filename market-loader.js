'use strict';
(() => {
  const nativeFetch = window.fetch.bind(window);
  let marketPromise = null;
  function market(){
    if(!marketPromise){
      marketPromise=nativeFetch(`data/market.json?v=${Date.now()}`,{cache:'no-store'}).then(r=>{if(!r.ok)throw new Error(`Market snapshot ${r.status}`);return r.json()});
    }
    return marketPromise;
  }
  function jsonResponse(obj,status=200){return new Response(JSON.stringify(obj),{status,headers:{'Content-Type':'application/json','Cache-Control':'no-store'}})}
  function unwrap(url){
    try{
      if(url.startsWith('https://api.allorigins.win/raw?url='))return decodeURIComponent(url.split('?url=')[1]||'');
      if(url.startsWith('https://corsproxy.io/?url='))return decodeURIComponent(url.split('?url=')[1]||'');
      if(url.startsWith('https://everyorigin.jwvbremen.nl/get?url='))return decodeURIComponent(url.split('?url=')[1]||'');
    }catch(_){return null}
    return null;
  }
  function yahooChartFromRows(ticker,interval,m){
    if(interval==='1d'){
      const rows=m.daily?.[ticker];if(!Array.isArray(rows)||!rows.length)return null;
      const timestamp=[],close=[],open=[],high=[],low=[],adj=[];
      for(const x of rows){const t=Math.floor(new Date(`${x.d}T12:00:00Z`).getTime()/1000);timestamp.push(t);close.push(x.a);open.push(x.a);high.push(x.ah);low.push(x.al);adj.push(x.a)}
      return{chart:{result:[{timestamp,indicators:{quote:[{open,high,low,close}],adjclose:[{adjclose:adj}]}}],error:null}};
    }
    const rows=m.hourly?.[ticker];if(!Array.isArray(rows)||!rows.length)return null;
    return{chart:{result:[{timestamp:rows.map(x=>x.t),indicators:{quote:[{open:rows.map(x=>x.c),high:rows.map(x=>x.h),low:rows.map(x=>x.l),close:rows.map(x=>x.c)}]}}],error:null}};
  }
  function quoteSummary(ticker,m){
    if(m.earnings?.complete!==true)return null;
    const event=m.earnings?.events?.[ticker];
    const dates=event?[{raw:Math.floor(new Date(`${event.date}T12:00:00Z`).getTime()/1000),fmt:event.date}]:[];
    return{quoteSummary:{result:[{calendarEvents:{earnings:{earningsDate:dates}}}],error:null}};
  }
  window.fetch=async function(input,init){
    const url=typeof input==='string'?input:(input?.url||'');
    const target=unwrap(url);
    if(!target)return nativeFetch(input,init);
    try{
      const u=new URL(target),m=await market();
      if(u.pathname.includes('/v8/finance/chart/')){
        const ticker=decodeURIComponent(u.pathname.split('/').pop()||'').toUpperCase(),interval=u.searchParams.get('interval')||'1d',payload=yahooChartFromRows(ticker,interval,m);
        return payload?jsonResponse(payload):jsonResponse({error:'Ticker snapshot unavailable'},404);
      }
      if(u.pathname.includes('/v10/finance/quoteSummary/')){
        const ticker=decodeURIComponent(u.pathname.split('/').pop()||'').toUpperCase(),payload=quoteSummary(ticker,m);
        return payload?jsonResponse(payload):jsonResponse({error:'Earnings snapshot incomplete'},503);
      }
      return jsonResponse({error:'Unsupported local market request'},404);
    }catch(e){console.error('Local market snapshot error',e);return jsonResponse({error:e?.message||'Local snapshot unavailable'},503)}
  };
  window.__marketSnapshot=market;
})();
