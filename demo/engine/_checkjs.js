// 编译 prototype.html 内所有 <script> 块，做语法校验（等价于 node --check 但针对内联脚本）
const fs = require('fs');
const vm = require('vm');
const html = fs.readFileSync(process.argv[2], 'utf8');
const re = /<script\b[^>]*>([\s\S]*?)<\/script>/gi;
let m, idx = 0, errs = 0;
while ((m = re.exec(html))) {
  const code = m[1];
  idx++;
  try {
    new vm.Script(code, { filename: `inline-${idx}.js` });
  } catch (e) {
    errs++;
    console.log(`SCRIPT #${idx} SYNTAX ERROR: ${e.message}`);
    console.log(code.slice(0, 300));
    console.log('----');
  }
}
console.log(`checked ${idx} inline script blocks, syntax_errors=${errs}`);
