// Firebase configuration lives in this file so the app remains a static GitHub Pages site.
// Create a Firebase web app, enable Firestore, then replace the placeholders below.
// This file is intentionally committed: Firebase web config is public by design; protect
// your project with appropriate Firestore Security Rules before sharing the site URL.
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.4/firebase-app.js";
import {
  addDoc, collection, deleteDoc, doc, getDocs, getFirestore, onSnapshot,
  orderBy, query, serverTimestamp, setDoc, updateDoc, where, writeBatch
} from "https://www.gstatic.com/firebasejs/10.12.4/firebase-firestore.js";
import {
  deleteObject, getDownloadURL, getStorage, ref, uploadBytes
} from "https://www.gstatic.com/firebasejs/10.12.4/firebase-storage.js";

const firebaseConfig = {
  apiKey: "AIzaSyA5bO7f27PauNlDVNBF_uSA4W6KaNgyUBQ",
  authDomain: "expense-tracker-29517.firebaseapp.com",
  projectId: "expense-tracker-29517",
  storageBucket: "expense-tracker-29517.firebasestorage.app",
  messagingSenderId: "809034635649",
  appId: "1:809034635649:web:199dacd69dc44ff7e17080"
};

const isConfigured = !Object.values(firebaseConfig).some((value) => value.includes("PASTE_YOUR"));
const app = isConfigured ? initializeApp(firebaseConfig) : null;
const db = app ? getFirestore(app) : null;
const storage = app ? getStorage(app) : null;

export {
  db, storage, isConfigured, addDoc, collection, deleteDoc, doc, getDocs, onSnapshot,
  orderBy, query, serverTimestamp, setDoc, updateDoc, where, writeBatch,
  deleteObject, getDownloadURL, ref, uploadBytes
};
