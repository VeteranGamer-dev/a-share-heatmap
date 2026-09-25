// 每次同步作者代码后执行：把我自己的修改重新应用一遍。
// 想加新的修改，就在 patches 里追加一项。
import { readFileSync, writeFileSync } from "node:fs";

const patches = [
  {
    name: "删除作者的 vibeloft 统计脚本",
    file: "src/app/layout.tsx",
    pattern: /[ \t]*<script\b[^>]*vibeloft\.ai[^>]*\/>\r?\n?/g,
    replacement: "",
    verify: (text) => !text.includes("vibeloft"),
  },
];

let failed = 0;
for (const patch of patches) {
  const before = readFileSync(patch.file, "utf8");
  const after = before.replace(patch.pattern, patch.replacement);
  writeFileSync(patch.file, after);
  if (patch.verify(after)) {
    console.log(`✓ ${patch.name}`);
  } else {
    failed += 1;
    console.log(`::warning file=${patch.file}::${patch.name} 没有生效，作者可能改了代码写法，需要更新 apply-patches.mjs`);
  }
}

if (failed > 0) console.log(`${failed} 项修改未生效（不影响站点运行）`);
