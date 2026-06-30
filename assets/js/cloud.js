// Optional cloud features (auth + saved history) backed by Firebase.
//
// The Firebase SDKs are loaded dynamically from Google's CDN ONLY when needed,
// and every call is defensive: if Firebase can't load (offline, blocked, or not
// configured) the converter keeps working — just without sign-in/history.
//
// Records store the EXTRACTED RESULT, never the original PDF, so "your PDFs stay
// in the browser" remains true.
import { firebaseConfig, FIREBASE_VERSION } from "./firebase-config.js";

const BASE = `https://www.gstatic.com/firebasejs/${FIREBASE_VERSION}`;

function configured() {
  return (
    firebaseConfig &&
    typeof firebaseConfig.apiKey === "string" &&
    firebaseConfig.apiKey &&
    !firebaseConfig.apiKey.includes("YOUR_")
  );
}

// Initialise Firebase and wire an auth-state callback. Returns an API object, or
// null if cloud features are unavailable (the app then runs converter-only).
export async function initCloud(onUserChange) {
  if (!configured()) return null;
  let appMod, authMod, fsMod;
  try {
    [appMod, authMod, fsMod] = await Promise.all([
      import(`${BASE}/firebase-app.js`),
      import(`${BASE}/firebase-auth.js`),
      import(`${BASE}/firebase-firestore.js`),
    ]);
  } catch (e) {
    console.warn("Cloud features unavailable (Firebase SDK failed to load):", e && e.message);
    return null;
  }

  let app, auth, db;
  try {
    app = appMod.initializeApp(firebaseConfig);
    auth = authMod.getAuth(app);
    db = fsMod.getFirestore(app);
  } catch (e) {
    console.warn("Cloud features unavailable (Firebase init failed):", e && e.message);
    return null;
  }

  authMod.onAuthStateChanged(auth, (user) => onUserChange && onUserChange(user));

  const mapError = (e) => {
    const code = (e && e.code) || "";
    const map = {
      "auth/invalid-email": "That email address looks invalid.",
      "auth/missing-password": "Please enter a password.",
      "auth/weak-password": "Password should be at least 6 characters.",
      "auth/email-already-in-use": "That email already has an account — try signing in.",
      "auth/invalid-credential": "Wrong email or password.",
      "auth/user-not-found": "No account with that email.",
      "auth/wrong-password": "Wrong email or password.",
      "auth/popup-closed-by-user": "Sign-in window was closed.",
      "auth/operation-not-allowed": "This sign-in method isn't enabled in Firebase yet.",
      "auth/popup-blocked": "Your browser blocked the sign-in popup.",
    };
    return map[code] || (e && e.message) || "Something went wrong.";
  };

  return {
    get user() {
      return auth.currentUser;
    },
    async signUpEmail(email, password) {
      try {
        await authMod.createUserWithEmailAndPassword(auth, email, password);
      } catch (e) {
        throw new Error(mapError(e));
      }
    },
    async signInEmail(email, password) {
      try {
        await authMod.signInWithEmailAndPassword(auth, email, password);
      } catch (e) {
        throw new Error(mapError(e));
      }
    },
    async signInGoogle() {
      try {
        const provider = new authMod.GoogleAuthProvider();
        await authMod.signInWithPopup(auth, provider);
      } catch (e) {
        throw new Error(mapError(e));
      }
    },
    async signOut() {
      await authMod.signOut(auth);
    },
    // Save one conversion (its extracted tables + metadata) for the current user.
    async saveConversion(record) {
      const user = auth.currentUser;
      if (!user) throw new Error("Please sign in first.");
      const payload = {
        uid: user.uid,
        createdAt: fsMod.serverTimestamp(),
        filename: record.filename || "statement.pdf",
        label: record.label || "",
        columns: Array.isArray(record.columns) ? record.columns.slice(0, 50).map(String) : [],
        rowCount: record.rowCount || 0,
        tableCount: record.tableCount || 0,
        // Firestore can't store nested arrays, so the tables are serialised.
        tablesJson: JSON.stringify(record.tables || []),
      };
      const ref = await fsMod.addDoc(fsMod.collection(db, "conversions"), payload);
      return ref.id;
    },
    // List the current user's saved conversions, newest first.
    async listConversions() {
      const user = auth.currentUser;
      if (!user) return [];
      // Filter by uid only (no composite index needed); sort client-side.
      const q = fsMod.query(fsMod.collection(db, "conversions"), fsMod.where("uid", "==", user.uid));
      const snap = await fsMod.getDocs(q);
      const items = [];
      snap.forEach((d) => {
        const data = d.data();
        let tables = [];
        try {
          tables = JSON.parse(data.tablesJson || "[]");
        } catch (_) {
          tables = [];
        }
        const ts = data.createdAt && data.createdAt.toDate ? data.createdAt.toDate() : null;
        items.push({
          id: d.id,
          filename: data.filename || "statement.pdf",
          label: data.label || "",
          columns: data.columns || [],
          rowCount: data.rowCount || 0,
          tableCount: data.tableCount || 0,
          createdAt: ts,
          tables,
        });
      });
      items.sort((a, b) => (b.createdAt ? b.createdAt.getTime() : 0) - (a.createdAt ? a.createdAt.getTime() : 0));
      return items;
    },
    async deleteConversion(id) {
      await fsMod.deleteDoc(fsMod.doc(db, "conversions", id));
    },
  };
}
