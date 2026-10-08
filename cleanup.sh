set -e
node -e "process.exit(+process.versions.node.split('.')[0] >= 22 ? 0 : 1)" || { echo "Switch to Node 22 first: nvm use 22"; exit 1; }

# Safety check: stop if any code actually uses Prisma
if grep -rIl "prisma" src tests views 2>/dev/null; then
  echo "Prisma is referenced in the files above - not removing it."
  exit 1
fi

npm uninstall @prisma/client prisma
git rm -q --ignore-unmatch prisma.config.ts prisma/schema.prisma
rm -rf prisma src/generated
sed -i '\#^/src/generated/prisma$#d' .gitignore

node -e "require('./src/app')" && echo "app loads OK"
npm test || { echo "Tests failed - not committing"; exit 1; }
git add -A
git commit -m "chore: remove unused Prisma files and dependencies"
echo "Done. Cleanup committed."
