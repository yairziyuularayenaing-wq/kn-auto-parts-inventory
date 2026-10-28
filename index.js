const { onCall, HttpsError } = require('firebase-functions/v2/https');
const { setGlobalOptions } = require('firebase-functions/v2');
const admin = require('firebase-admin');
admin.initializeApp();
setGlobalOptions({ region: 'asia-southeast3', maxInstances: 10 });
const db = admin.firestore();
const LOCATIONS = ['Purchase Location','Myawaddy','In Transit','Yangon Warehouse'];
function requireUser(req) { if (!req.auth) throw new HttpsError('unauthenticated','Please log in.'); return req.auth; }
function requireStaff(req) { const a=requireUser(req); if (!['admin','staff'].includes(a.token.role)) throw new HttpsError('permission-denied','Admin/Staff role required.'); return a; }
function requireAdmin(req) { const a=requireUser(req); if (a.token.role !== 'admin') throw new HttpsError('permission-denied','Admin role required.'); return a; }
function text(v,max=160){return String(v??'').trim().slice(0,max)}
function amount(v,label){const n=Number(v);if(!Number.isFinite(n)||n<0)throw new HttpsError('invalid-argument',label+' must be zero or positive.');return n}
exports.bootstrapFirstAdmin = onCall(async req => {
  const user=requireUser(req); const email=text(user.token.email,200);
  if (!email) throw new HttpsError('failed-precondition','Account email is missing.');
  return db.runTransaction(async tx=>{
    const admins=await tx.get(db.collection('users').where('role','==','admin').limit(1));
    if(!admins.empty) throw new HttpsError('failed-precondition','An admin already exists. Ask the existing admin to assign your role.');
    const userRef=db.collection('users').doc(user.uid); const old=await tx.get(userRef);
    tx.set(userRef,{uid:user.uid,email,role:'admin',createdAt:old.exists?(old.data().createdAt||admin.firestore.FieldValue.serverTimestamp()):admin.firestore.FieldValue.serverTimestamp(),updatedAt:admin.firestore.FieldValue.serverTimestamp()},{merge:true});
    return {role:'admin'};
  }).then(async result=>{await admin.auth().setCustomUserClaims(user.uid,{role:'admin'});return result;});
});
exports.createProduct = onCall(async req=>{
  const user=requireStaff(req), d=req.data||{}; const name=text(d.name,180); if(!name)throw new HttpsError('invalid-argument','Product name is required.');
  const quantity=Number(d.quantity); if(!Number.isInteger(quantity)||quantity<0)throw new HttpsError('invalid-argument','Quantity must be a non-negative integer.');
  const location=text(d.location,80);if(!LOCATIONS.includes(location))throw new HttpsError('invalid-argument','Invalid stock location.');
  const currency=text(d.currency,3);if(!['MMK','THB'].includes(currency))throw new HttpsError('invalid-argument','Currency must be MMK or THB.');
  const purchasePrice=amount(d.purchasePrice,'Purchase price'),sellingPrice=amount(d.sellingPrice,'Selling price');
  const ref=db.collection('products').doc(); const now=admin.firestore.FieldValue.serverTimestamp(); const stock=Object.fromEntries(LOCATIONS.map(l=>[l,0]));stock[location]=quantity;
  await db.runTransaction(async tx=>{tx.create(ref,{name,category:text(d.category,80),brand:text(d.brand,80),model:text(d.model,100),partNo:text(d.partNo,100),year:text(d.year,30),side:text(d.side,20),condition:text(d.condition,30),stock,currency,purchasePrice,sellingPrice,notes:text(d.notes,1000),createdAt:now,createdBy:user.uid,updatedAt:now});if(quantity>0){const log=db.collection('stockTransactions').doc();tx.create(log,{productId:ref.id,type:'OPENING',quantity,fromLocation:null,toLocation:location,reference:'OPENING',notes:'Opening stock',createdBy:user.uid,createdByEmail:text(user.token.email,200),createdAt:now});}});
  return {id:ref.id};
});
exports.postStockTransaction = onCall(async req=>{
  const user=requireStaff(req), d=req.data||{}; const productId=text(d.productId,140),type=text(d.type,20),quantity=Number(d.quantity),from=text(d.fromLocation,80),to=text(d.toLocation,80);
  if(!productId)throw new HttpsError('invalid-argument','Product is required.');if(!Number.isInteger(quantity)||quantity<=0)throw new HttpsError('invalid-argument','Quantity must be a positive integer.');
  if(!['IN','OUT','TRANSFER','ADJUST'].includes(type))throw new HttpsError('invalid-argument','Invalid transaction type.');if(type==='ADJUST')requireAdmin(req);
  if(type==='IN'&&!LOCATIONS.includes(to))throw new HttpsError('invalid-argument','Choose a destination location.');
  if((type==='OUT'||type==='TRANSFER'||type==='ADJUST')&&!LOCATIONS.includes(from))throw new HttpsError('invalid-argument','Choose a source location.');
  if(type==='TRANSFER'&&(!LOCATIONS.includes(to)||to===from))throw new HttpsError('invalid-argument','Choose a different destination.');
  const pRef=db.collection('products').doc(productId),logRef=db.collection('stockTransactions').doc();
  await db.runTransaction(async tx=>{
    const snap=await tx.get(pRef);if(!snap.exists)throw new HttpsError('not-found','Product not found.');const p=snap.data(),stock={...Object.fromEntries(LOCATIONS.map(l=>[l,0])),...(p.stock||{})};
    if(type==='OUT'||type==='TRANSFER'||type==='ADJUST'){if(Number(stock[from]||0)<quantity)throw new HttpsError('failed-precondition','Not enough stock at source location.');stock[from]=Number(stock[from]||0)-quantity;}
    if(type==='IN'||type==='TRANSFER')stock[to]=Number(stock[to]||0)+quantity;
    if(type==='ADJUST'){const delta=Number(d.delta);if(!Number.isInteger(delta)||delta===0)throw new HttpsError('invalid-argument','For ADJUST, send non-zero integer delta.');const next=Number(p.stock?.[from]||0)+delta;if(next<0)throw new HttpsError('failed-precondition','Adjustment cannot make stock negative.');stock[from]=next;}
    const now=admin.firestore.FieldValue.serverTimestamp();tx.update(pRef,{stock,updatedAt:now,updatedBy:user.uid});tx.create(logRef,{productId,type,quantity,fromLocation:(type==='OUT'||type==='TRANSFER'||type==='ADJUST')?from:null,toLocation:(type==='IN'||type==='TRANSFER')?to:null,reference:text(d.reference,100),notes:text(d.notes,1000),createdBy:user.uid,createdByEmail:text(user.token.email,200),createdAt:now});
  });return {transactionId:logRef.id};
});
exports.setStaffRole = onCall(async req=>{const actor=requireAdmin(req),uid=text(req.data?.uid,128),role=text(req.data?.role,20);if(!uid||!['staff','admin','disabled'].includes(role))throw new HttpsError('invalid-argument','Provide a valid uid and role.');if(uid===actor.uid&&role!=='admin')throw new HttpsError('failed-precondition','You cannot remove your own admin role here.');const target=await admin.auth().getUser(uid);const claims={...(target.customClaims||{})};if(role==='disabled')delete claims.role;else claims.role=role;await admin.auth().setCustomUserClaims(uid,claims);await db.collection('users').doc(uid).set({uid,email:target.email||'',role,updatedAt:admin.firestore.FieldValue.serverTimestamp(),updatedBy:actor.uid},{merge:true});return {uid,role};});
