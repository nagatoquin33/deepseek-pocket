import fs from "node:fs";
const f="D:/ai/deepseek-mobile/.gitignore";
let t=fs.readFileSync(f,"utf8");
t=t.replace("\nsite/\n", "\n/site/\n");
fs.writeFileSync(f,t,"utf8");
console.log("gitignore fixed:", t.includes("/site/"));
