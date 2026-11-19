import fs from "node:fs";
const f="D:/ai/deepseek-mobile/.github/workflows/build-apk.yml";
let y=fs.readFileSync(f,"utf8");
y=y.replace(`      - name: Build signed APK
        env:`, `      - name: Resolve version
        run: |
          if [[ "\${GITHUB_REF}" == refs/tags/v* ]]; then
            echo "VERSION_NAME=\${GITHUB_REF_NAME#v}" >> "$GITHUB_ENV"
          else
            echo "VERSION_NAME=1.0.0" >> "$GITHUB_ENV"
          fi
          echo "VERSION_CODE=\${GITHUB_RUN_NUMBER}" >> "$GITHUB_ENV"
          echo "版本: \${VERSION_NAME:-1.0.0} (\${GITHUB_RUN_NUMBER})"

      - name: Build signed APK
        env:`);
fs.writeFileSync(f,y,"utf8");
console.log("workflow version resolved");
