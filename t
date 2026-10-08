[33mcommit 6e5e3f19cd5357bdb545f8641abf791c01acdb91[m
Author: Newton Kirimi Miriti <newtonkirimi55@gmail.com>
Date:   Thu Oct 8 15:17:14 2026 -0500

    feat(engagement): add likes and bookmarks

[1mdiff --git a/.gitignore b/.gitignore[m
[1mindex cfacb44..d6dfd15 100644[m
[1m--- a/.gitignore[m
[1m+++ b/.gitignore[m
[36m@@ -8,3 +8,5 @@[m [msrc/public/uploads/chat/*[m
 [m
 # git bundles[m
 *.bundle[m
[32m+[m
[32m+[m[32m/src/generated/prisma[m
[1mdiff --git a/package.json b/package.json[m
[1mindex 6acad65..d76a4de 100644[m
[1m--- a/package.json[m
[1m+++ b/package.json[m
[36m@@ -12,6 +12,7 @@[m
     "test": "NODE_ENV=test jest --runInBand"[m
   },[m
   "dependencies": {[m
[32m+[m[32m    "@prisma/client": "^7.0.0",[m
     "bcryptjs": "^2.4.3",[m
     "better-sqlite3": "^13.0.3",[m
     "connect-flash": "^0.1.1",[m
[36m@@ -23,6 +24,7 @@[m
     "multer": "^2.2.0",[m
     "passport": "^0.7.0",[m
     "passport-local": "^1.0.0",[m
[32m+[m[32m    "prisma": "^7.0.0",[m
     "socket.io": "^4.8.4"[m
   },[m
   "devDependencies": {[m
