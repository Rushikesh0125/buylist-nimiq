// Local Vite-only verification fixture. Not an application entry or production build input.
import React from "react";
import { createRoot } from "react-dom/client";
import Workspace from "../src/Workspace";
import "../src/prototype.css";
import "../src/website.css";
import "@fontsource/dm-sans/400.css";
import "@fontsource/bricolage-grotesque/800.css";

if (!import.meta.env.DEV) throw new Error("Fixtures require the local development server.");
window.fetch = async (input, options) => {
  const path = String(input);
  if (path === "/api/config") return Response.json({nimiqEnabled: true});
  if (path === "/api/auth/session") return Response.json({user: {id:"fixture-user",name:"Fixture tester",email:"fixture@example.test"},csrfToken:"fixture-only"});
  if (path === "/api/goals" && (!options?.method || options.method === "GET")) return Response.json({goals:[]});
  if (path === "/api/payments/activity") return Response.json({payments:[]});
  if (path === "/api/payments/config") return Response.json({clientId:null,enabled:false});
  if (path === "/api/products/search") {
    const {query} = JSON.parse(String(options?.body));
    document.getElementById("fixture-start")!.textContent="Request started: "+query;
    // Deliberately ignore cancellation to verify stale responses cannot replace the current query.
    await new Promise(resolve => setTimeout(resolve, query === "slow" ? 2000 : 80));
    document.getElementById("fixture-finish")!.textContent="Response finished: "+query;
    if (query === "error") return Response.json({error:{code:"FIXTURE_FAILURE",message:"Fixture search unavailable"}},{status:503});
    return Response.json({products:query === "empty" ? [] : Array.from({length:16},(_,i)=>({id:query+"-"+i,title:query+" fixture product "+(i+1),priceCents:10000+i,currency:"USD",available:i!==1,imageUrl:null,merchant:"fixture.example",merchantUrl:"https://example.test",observedAt:0,offers:[]}))});
  }
  throw new Error("Unexpected fixture request: " + path);
};
createRoot(document.getElementById("root")!).render(<React.StrictMode><Workspace/></React.StrictMode>);
