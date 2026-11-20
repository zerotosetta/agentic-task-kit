export const dashboardHtml = `<!doctype html>
<html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>작업 세션 · ATK</title><link rel="stylesheet" href="/app.css"><script src="/app.js" defer></script></head>
<body><header><div class="bar"><a href="/" data-home class="brand"><b>ATK</b> 작업 세션</a><button id="logout" hidden>연결 해제</button></div></header>
<main><p id="notice" role="status" aria-live="polite"></p><section id="login" class="panel login">
<h1>세션 대시보드 연결</h1><p>서버 액세스 토큰을 입력하면 작업 현황과 인계 내용을 확인할 수 있습니다.</p>
<form id="auth"><label for="token">액세스 토큰</label><input id="token" type="password" autocomplete="off" required><button class="primary">연결</button></form></section>
<div id="view"></div></main></body></html>`;

export const dashboardStyles = `
:root{color-scheme:light;font-family:Inter,"Malgun Gothic",system-ui,sans-serif;color:#182b32;background:#f3f6f5;line-height:1.6}
*{box-sizing:border-box}body{margin:0}header{background:#14353b;color:white}.bar,main{max-width:1080px;margin:auto;padding:15px clamp(16px,4vw,48px)}.bar,.row,.tools{display:flex;align-items:center;justify-content:space-between;gap:14px;flex-wrap:wrap}.brand{color:white;text-decoration:none;font-weight:600}.brand b{display:inline-block;margin-right:10px;letter-spacing:.08em;color:#a9e4cd}
main{padding-top:24px;padding-bottom:60px}h1,h2,p{margin:0 0 12px}h1{font-size:clamp(24px,4vw,36px);letter-spacing:-.045em}h2{font-size:19px;letter-spacing:-.025em}h3{font-size:16px}a{color:#12644e}button,input,textarea,select{font:inherit;border-radius:6px;border:1px solid #a4b4b1;padding:7px 12px;background:white;color:inherit}button{cursor:pointer;font-weight:600}button:hover{background:#eaf3ee}button.primary{background:#12644e;color:white;border-color:#12644e}button:disabled{opacity:.55;cursor:wait}a:focus-visible,button:focus-visible,input:focus-visible,textarea:focus-visible,select:focus-visible{outline:3px solid #1677a5;outline-offset:2px}.bar button{color:#14353b}.panel,.card{padding:clamp(16px,3vw,26px);background:white;border:1px solid #cfdad6;border-radius:10px;margin:15px 0}.login{max-width:520px;margin:7vh auto}.login input,textarea{width:100%;margin:5px 0 12px}label{display:block;font-weight:600}.tools{justify-content:flex-start;align-items:end}.tools input{max-width:100%}small,.muted{color:#496059}#notice:empty{display:none}#notice{background:#e5efeb;padding:10px 14px;border-left:3px solid #297257}.card{padding:16px 20px}.card p:last-child{margin-bottom:0}.tag{display:inline-block;font-size:13px;font-weight:650;border-radius:5px;padding:2px 8px;background:#e3f1ec;color:#21523f}.meta{font-size:14px;color:#496059;white-space:pre-wrap}.text{white-space:pre-wrap}main{overflow-wrap:anywhere}progress{display:block;max-width:100%;accent-color:#12644e}li{margin:6px 0}textarea{resize:vertical;min-height:100px}#content{font-family:"IBM Plex Mono",Consolas,monospace;min-height:220px}.item{padding:10px 0;border-top:1px solid #dfE6e2}.item button{margin:4px 0}nav{margin-bottom:15px}form .tools{margin:8px 0}ol{padding-left:24px}[hidden]{display:none!important}
`;

export const dashboardScript = String.raw`
'use strict';
(() => {
  const $ = id => document.getElementById(id);
  let token = '', epoch = 0, sessionId = null, query = '', offset = 0, filter = '', busy = false;
  let ctx = null, noteVersion = null, edit = null, artifactKey = '', loadingFiles = 0;
  const snapshots = new Map();
  const statuses = {queued:'대기',running:'실행 중',interrupted:'중단',cancelled:'취소',failed:'실패',completed:'완료'};
  const phases = {preparing:'준비 중',executing:'수행 중',finalizing:'마무리 중',...statuses};
  function el(tag, text, cls) {
    const node = document.createElement(tag);
    if (text !== undefined) node.textContent = text;
    if (cls) node.className = cls;
    return node;
  }
  function act(label, fn) {
    const button = el('button',label);
    button.type = 'button';
    button.onclick = () => task(button,fn);
    return button;
  }
  async function task(button, fn) {
    const started = epoch;
    button.disabled = true;
    try { await fn(); } catch(e) { if(started === epoch) notice(e.message); }
    finally { button.disabled = false; }
  }
  function notice(message) { $('notice').textContent = message; }
  function date(value) { return value ? new Date(value).toLocaleString('ko-KR') : '—'; }
  async function call(name,args) {
    const res = await fetch('/api/tools/'+name,{method:'POST',cache:'no-store',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},body:JSON.stringify(args)});
    const body = await res.json();
    if(res.status===401 && !dirty()) {
      token=''; openRoute(); notice('액세스 토큰을 확인하고 다시 연결해 주세요.'); $('token').focus();
      throw Error('액세스 토큰이 유효하지 않습니다.');
    }
    if (!res.ok || body.error) throw Error(body.error?.message || body.message || ('요청 실패 ('+res.status+')'));
    return body;
  }
  function paint(id,data,draw) {
    const key = JSON.stringify(data);
    if (snapshots.get(id) === key) return;
    const part = document.createDocumentFragment();
    draw(part); $(id).replaceChildren(part); snapshots.set(id,key);
  }
  function relative(url, text) {
    const a = el('a',text); a.href = url;
    a.onclick = event => {
      if (event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
      event.preventDefault(); if (location.pathname !== url && canLeave()) { history.pushState(null,'',url); openRoute(); }
    };
    return a;
  }
  function dirty() { return !!(($('noteEdit') && !$('noteEdit').hidden) || (edit && $('content')?.value !== edit.content)); }
  function canLeave() { return !dirty() || confirm('저장하지 않은 편집 내용을 닫을까요?'); }
  window.addEventListener('beforeunload',e=>{if(dirty()){e.preventDefault();e.returnValue='';}});
  function showProgress(parent,p) {
    parent.append(el('span',statuses[p?.status] || '실행 전','tag'));
    if (!p) return;
    const stage=p.stage, d=p.detail;
    parent.append(el('p',[stage?.stepKey || phases[stage?.phase],stage?.position && stage.total ? '선언 순서 '+stage.position+' / '+stage.total : ''].filter(Boolean).join(' · '),'meta'));
    if (!d) { parent.append(el('small','작업자가 보고한 세부 진행 정보가 없습니다.')); return; }
    parent.append(el('p',[d.operation,d.item,d.message].filter(Boolean).join(' · '),'text'));
    if (d.completed != null) parent.append(el('span','보고된 작업량 '+d.completed+(d.total != null?' / '+d.total:'')+' '+(d.unit || '')));
    if (d.percent != null) { const meter=el('progress'); meter.max=100; meter.value=d.percent; meter.setAttribute('aria-label','보고된 작업 진행률 '+d.percent+'%'); parent.append(meter,el('small',d.percent+'%')); }
  }
  function home() {
    $('view').innerHTML = '<h1>작업 세션</h1><form id="search" class="tools"><label>세션 검색<br><input id="q" type="search" placeholder="제목 또는 세션 ID"></label><label>상태<br><select id="filter"><option value="">전체</option></select></label><button>검색</button><button id="refresh" type="button">새로고침</button></form><div id="list"></div><div id="pages" class="tools"></div>';
    $('q').value=query;
    for(const [key,label] of Object.entries({...statuses,none:'실행 전'})) $('filter').append(new Option(label,key));
    $('filter').value=filter;
    $('search').onsubmit=e=>{e.preventDefault(); query=$('q').value.trim(); filter=$('filter').value; offset=0; openRoute();};
    $('filter').onchange=()=>$('search').requestSubmit(); $('refresh').onclick=()=>refresh();
  }
  async function list(started) {
    const rows=[]; let next=filter?0:offset;
    do {
      const page=await call('session_list',{query,offset:next,limit:25});
      if(started!==epoch)return;
      rows.push(...page.sessions.filter(s=>!filter || (s.status?.status || 'none')===filter));
      if(page.nextOffset!==null && page.nextOffset<=next) throw Error('세션 목록의 페이지 순서가 올바르지 않습니다.');
      next=page.nextOffset;
    } while(filter && next!==null && rows.length<=offset+25);
    const visible=filter?rows.slice(offset,offset+25):rows;
    paint('list',visible,box=>{
      if(!visible.length) box.append(el('p',query||filter?'조건에 맞는 세션이 없습니다.':'등록된 세션이 없습니다.','panel'));
      for(const s of visible) {
        const card=el('article',undefined,'card'), title=el('h2');
        title.append(relative('/app/sessions/'+encodeURIComponent(s.sessionId),s.title || s.sessionId));
        card.append(title,el('p',s.goal,'text')); showProgress(card,s.status);
        card.append(el('p','최근 수정 '+date(s.updatedAt),'meta')); box.append(card);
      }
    });
    const more=filter?rows.length>offset+25:next!==null;
    paint('pages',[offset,more],box=>{
      if(offset) box.append(act('이전',()=>{offset=Math.max(0,offset-25);openRoute();}));
      if(more) box.append(act('다음',()=>{offset+=25;openRoute();}));
    });
  }
  function detail() {
    $('view').innerHTML = '<nav id="back"></nav><h1 id="title">세션 불러오는 중…</h1><p id="goal" class="text"></p><button id="refresh">새로고침</button><section class="panel"><h2>실행 현황</h2><div id="progress"></div></section><section class="panel"><h2>인계 메모</h2><div id="notes"></div><form id="noteEdit" hidden><label>요약<textarea id="summary"></textarea></label><label>다음 작업<textarea id="next"></textarea></label><div class="tools"><button class="primary">저장</button><button id="cancelNote" type="button">닫기</button></div></form></section><section class="panel"><h2>작업 파일</h2><div id="files"></div><form id="editor" hidden><label>파일 경로<input id="path" required></label><label>내용<textarea id="content" spellcheck="false"></textarea></label><div class="tools"><button class="primary">새 버전 저장</button><button id="closeFile" type="button">닫기</button></div></form></section><section class="panel"><h2>최종 결과물</h2><div id="finals"></div></section><section class="panel"><h2>중간 산출물</h2><div id="artifacts"></div></section>';
    $('back').append(relative('/','← 세션 목록')); $('refresh').onclick=()=>refresh();
    $('cancelNote').onclick=()=>{$('noteEdit').hidden=true;};
    $('closeFile').onclick=()=>{if(!edit || $('content').value===edit.content || confirm('파일 편집을 닫을까요?')){edit=null;$('editor').hidden=true;loadingFiles++;}};
    $('noteEdit').onsubmit=e=>{e.preventDefault(); const started=epoch; task(e.submitter,async()=>{
      await call('session_note',{sessionId,expectedVersion:noteVersion,summary:$('summary').value,nextAction:$('next').value});
      if(started!==epoch)return; $('noteEdit').hidden=true;notice('인계 메모를 저장했습니다.');await refresh(true);
    });};
    $('editor').onsubmit=e=>{e.preventDefault(); const started=epoch; task(e.submitter,async()=>{
      await call('workspace_write',{sessionId,path:$('path').value,expectedVersion:edit.version,content:$('content').value});
      if(started!==epoch)return; edit=null;$('editor').hidden=true;notice('파일을 저장했습니다.');await refresh(true);
    });};
  }
  function renderContext(data) {
    const {session:s,run,progress:p}=data;
    $('title').textContent=s.title; $('goal').textContent=s.goal; document.title=s.title+' · ATK';
    paint('progress',[p,run,data.stageOrder,data.completedStages],box=>{
      showProgress(box,p);
      if(run) {
        box.append(el('p','현재 단계 '+(run.currentStep || '—')+' · 마지막 확정 단계 '+(run.lastCompletedStep?.stepKey || '—'),'meta'));
        if(data.stageOrder.length) {
          const order=el('ol'), completed=new Set(data.completedStages || []);
          for(const step of data.stageOrder){
            const marks=[step===run.currentStep?'현재':'',completed.has(step)?'확정 기록 있음':''].filter(Boolean);
            order.append(el('li',step+(marks.length?' ('+marks.join(' · ')+')':'')));
          }
          box.append(el('h3','선언된 단계 순서'),order);
        }
        if(run.error) box.append(el('p',run.error.message,'text'));
        if(run.nextAction?.action==='resume') box.append(act('실행 재개',async()=>{
          const started=epoch;
          await call('workflow_resume',run.nextAction.arguments);
          if(started===epoch){notice('재개를 요청했습니다.');await refresh(true);}
        }));
      }
    });
    paint('notes',[s.summary,s.nextAction,s.version],box=>{
      box.append(el('h3','요약'),el('p',s.summary || '아직 작성되지 않았습니다.','text'),el('h3','다음 작업'),el('p',s.nextAction || '아직 작성되지 않았습니다.','text'),act('메모 편집',()=>{
        if($('noteEdit').hidden){noteVersion=s.version;$('summary').value=s.summary;$('next').value=s.nextAction;$('noteEdit').hidden=false;} $('summary').focus();
      }));
    });
    paint('files',data.files,box=>{
      if(!data.files.length)box.append(el('p','저장된 파일이 없습니다.','muted'));
      for(const f of data.files){
        const row=el('div',undefined,'item'), controls=el('div',undefined,'tools'), version=el('input');
        version.type='number';version.min='1';version.max=String(f.version);version.value=String(f.version);version.setAttribute('aria-label',f.path+' 읽을 버전');
        controls.append(el('span','버전 1–'+f.version),version,act('열기',async()=>{
          if(!version.reportValidity())return;
          if(edit && $('content').value!==edit.content && !confirm('편집 중인 파일을 닫을까요?'))return;
          const request=++loadingFiles,started=epoch;
          const file=await call('workspace_read',{sessionId,path:f.path,version:Number(version.value)});
          if(started===epoch && request===loadingFiles)openEditor(f.path,file.version,file.content);
        }));
        row.append(el('strong',f.path),el('p',f.size+' B · '+date(f.updatedAt),'meta'),controls);box.append(row);
      }
      box.append(act('새 파일',()=>{if(edit && $('content').value!==edit.content && !confirm('편집 중인 파일을 닫을까요?'))return;loadingFiles++;openEditor('',0,'');}));
    });
    paint('finals',[data.publications,run?.runId],box=>artifactList(box,data.publications,run,'게시된 최종 결과물이 없습니다.'));
  }
  function openEditor(path,version,content) {
    edit={version,content};$('editor').hidden=false;$('path').readOnly=!!path;$('path').value=path;$('content').value=content;$(path?'content':'path').focus();
  }
  function artifactList(box,refs,run,empty) {
    if(!refs.length)box.append(el('p',empty,'muted'));
    for(const {name,artifact} of refs){
      const row=el('div',undefined,'item');row.append(el('strong',name),el('p',artifact.kind+' · SHA-256 '+artifact.sha256,'meta'));
      if(run)row.append(act('검증 후 다운로드',()=>download(sessionId,run.runId,name,artifact)));
      box.append(row);
    }
  }
  async function download(sid,runId,name,ref) {
    const started=epoch;
    let cursor,offset=0,bytes,seq;
    const seen=new Set();
    do {
      const p=await call('workflow_results',{sessionId:sid,runId,artifactId:ref.id,cursor,maxBytes:262144});
      if(started!==epoch)return;
      if(p.runId!==runId || p.artifact?.id!==ref.id || p.artifact.sha256!==ref.sha256 || p.artifact.kind!==ref.kind || p.offset!==offset || !Number.isSafeInteger(p.totalBytes) || p.totalBytes<0 || (bytes && (bytes.length!==p.totalBytes || p.checkpointSeq!==seq)))throw Error('결과물 정보가 일치하지 않습니다.');
      if(!bytes){bytes=new Uint8Array(p.totalBytes);seq=p.checkpointSeq;}
      const chunk=Uint8Array.from(atob(p.data),c=>c.charCodeAt(0));bytes.set(chunk,offset);offset+=chunk.length;cursor=p.nextCursor;
      if(cursor!==null && (!cursor || seen.has(cursor) || !chunk.length))throw Error('결과물 페이지가 올바르지 않습니다.');
      seen.add(cursor);
    }while(cursor!==null);
    const hash=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes)),b=>b.toString(16).padStart(2,'0')).join('');
    if(bytes.length!==offset || hash!==ref.sha256)throw Error('결과물의 SHA-256 검증에 실패했습니다.');
    if(started!==epoch)return;
    const url=URL.createObjectURL(new Blob([bytes],{type:'application/octet-stream'})),a=el('a');
    a.href=url;a.download=(name || ref.id).replace(/[<>:"/\\|?*\x00-\x1f]/g,'_');document.body.append(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(url),30000);
    notice('SHA-256 검증을 마치고 다운로드를 시작했습니다.');
  }
  async function loadArtifacts(data,started) {
    const run=data.run,key=JSON.stringify([run?.runId,run?.checkpointSeq,data.publications]);
    if(key===artifactKey)return;
    const ids=new Set(data.publications.map(x=>x.artifact.id)),refs=[],seen=new Set();
    let cursor;
    if(run)do{
      const page=await call('workflow_results',{sessionId,runId:run.runId,cursor,maxBytes:262144});
      if(epoch!==started)return;
      for(const artifact of page.artifacts)if(!ids.has(artifact.id))refs.push({name:artifact.id,artifact});
      cursor=page.nextCursor;
      if(cursor!==null && (!cursor || seen.has(cursor)))throw Error('산출물 페이지가 올바르지 않습니다.');
      seen.add(cursor);
    }while(cursor!==null);
    paint('artifacts',[refs,run?.runId],box=>artifactList(box,refs,run,'확정된 중간 산출물이 없습니다.'));artifactKey=key;
  }
  async function refresh(force=false) {
    if(!token || busy && !force)return;
    const started=epoch,ticket=Symbol();busy=ticket;
    try {
      if(sessionId){
        const data=await call('session_context',{sessionId});if(started!==epoch || busy!==ticket)return;
        ctx=data;renderContext(ctx);await loadArtifacts(ctx,started);
      }else await list(started);
    }catch(e){if(started===epoch)notice(e.message);}
    finally{if(busy===ticket)busy=false;}
  }
  function openRoute() {
    epoch++;busy=false;edit=null;ctx=null;artifactKey='';snapshots.clear();notice('');document.title='작업 세션 · ATK';
    const match=location.pathname.match(/^\/app\/sessions\/([^/]+)\/?$/);
    sessionId=match?decodeURIComponent(match[1]):null;
    $('login').hidden=!!token;$('logout').hidden=!token;
    $('view').replaceChildren();if(!token)return;
    if(sessionId)detail();else home();refresh();
  }
  $('auth').onsubmit=e=>{e.preventDefault();token=$('token').value.trim();$('token').value='';openRoute();};
  $('logout').onclick=()=>{if(canLeave()){token='';openRoute();$('token').focus();}};
  document.querySelector('[data-home]').onclick=e=>{if(e.ctrlKey || e.metaKey || e.shiftKey || e.altKey)return;e.preventDefault();if(canLeave()){history.pushState(null,'','/');openRoute();}};
  window.addEventListener('popstate',openRoute);
  setInterval(()=>{if(!document.hidden)refresh();},5000);
  openRoute();
})();
`;
