import puppeteer from "puppeteer-core";
const b=await puppeteer.launch({executablePath:"C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",headless:"new",args:["--no-sandbox","--lang=zh-CN"],defaultViewport:{width:390,height:844,deviceScaleFactor:2,isMobile:true,hasTouch:true}});
const p=await b.newPage();
const errs=[]; p.on("pageerror",e=>errs.push("PAGEERR "+e.message)); p.on("console",m=>{if(m.type()==="error")errs.push("CONSOLE "+m.text())});
const wait=ms=>new Promise(r=>setTimeout(r,ms));
await p.goto("http://127.0.0.1:8899/?demo=1",{waitUntil:"networkidle2"});
await wait(900);
await p.type("#input","hi"); await wait(200);
await p.evaluate(()=>document.querySelector("#btn-send").click());
await wait(5000);
const budget = await p.evaluate(()=>({hidden:document.querySelector('#context-bar').hidden, text:document.querySelector('#context-text').textContent}));
await p.screenshot({path:"D:\\ai\\deepseek-mobile\\docs\\screenshots\\ux-budget.png"});
// 提示词页
await p.evaluate(()=>document.querySelector('#btn-menu').click()); await wait(400);
await p.evaluate(()=>document.querySelector('#btn-account').click()); await wait(600);
await p.evaluate(()=>document.querySelector('[data-go="prompts"]')?.click()); await wait(500);
const promptInfo = await p.evaluate(()=>({rows:document.querySelectorAll('.prompt-item').length, label:document.querySelector('.group-label')?.textContent}));
await p.screenshot({path:"D:\\ai\\deepseek-mobile\\docs\\screenshots\\ux-prompts.png"});
// 返回，消息菜单
await p.evaluate(()=>document.querySelector('[data-back]').click()); await wait(300);
await p.evaluate(()=>document.querySelector('[data-back]').click()); await wait(400);
await p.evaluate(()=>{const m=document.querySelector('#messages');m.scrollTop=m.scrollHeight;}); await wait(300);
const menuItems = await p.evaluate(async()=>{document.querySelector('.msg.assistant [data-act="more"]').click(); await new Promise(r=>setTimeout(r,300)); return [...document.querySelectorAll('.sheet-body .side-item')].map(e=>e.textContent.trim());});
console.log(JSON.stringify({budget,promptInfo,menuItems,errs:errs.slice(0,3)},null,2));
await b.close();
