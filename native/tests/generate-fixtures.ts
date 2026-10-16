// Run from the repository root: node --import tsx native/tests/generate-fixtures.ts
import { writeFileSync } from "node:fs";
import { generateDiffString } from "@earendil-works/pi-coding-agent";
import { writeChange, readChanges } from "../../src/changes.ts";
import { coloredDiff } from "../../src/diff.ts";
import type { Theme } from "@earendil-works/pi-coding-agent";

const pairs: Array<[string,string]> = [
  ["", ""], ["", "one\ntwo\n"], ["one\n", ""], ["a\nb\na\n", "a\na\nb\n"],
  ["before\n", "after\n"], ["line", "line\n"], ["a\r\nb\r\n", "a\r\nc\r\n"],
  ["한글 🐷\n", "한글 🐽\n"], [Array.from({length:40},(_,i)=>`${i}`).join("\n"), Array.from({length:40},(_,i)=>i===20?"changed":`${i}`).join("\n")],
];
let seed=42;
const random=()=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed;};
for(let i=0;i<120;i++) {
  const a=Array.from({length:random()%25},()=>["foo", "bar", "한글", "🐷", "", "x "][random()%6]).join("\n");
  const b=Array.from({length:random()%25},()=>["foo", "bar", "한글", "🐷", "", "x "][random()%6]).join("\n");
  pairs.push([a,b]);
}
const before = [{kind:"missing"}, {kind:"text",content:"before\n"}, {kind:"text",content:"\ufeffsame\r\n"}, {kind:"omitted",sizeBytes:999999}, {kind:"unavailable",reason:"Previous content is binary; text diff unavailable."}] as const;
const writes=before.flatMap(before=>["", "same\n", "after\n", "zero\0", "한".repeat(90000), "a\n".repeat(2001)].map(content=>({before,...(content.length>10000?{repeat:"한",count:90000}:{content}),expected:writeChange("root/1","file.txt",before,content)})));
const theme={fg:(_token:string,s:string)=>s,inverse:(s:string)=>`\u001b[7m${s}\u001b[27m`} as Theme;
const wordInputs=[
  "-1 const timeout = 1000;\n+1 const timeout = 5000;",
  "-1   old\n+1   new", "-1 const a = 1;\n+1 const b = 2;", "-1 hello world\n+1 hello  world",
  "-1 old\n-2 another\n+1 new\n+2 other", "-1 café foo\n+1 café bar", "-1 한글 🐷\n+1 한글 🐽",
  "-1   old(value);\n+1   new(value);", "-1 foo();\n+1 foo(bar);", "-1 foo(bar);\n+1 foo();",
  "-1 \n+1 new", "-1 old\n+1 ", "-1 first = 1; last = 2;\n+1 first = 3; last = 4;",
  "-1 이름 = '이전 😀';\n+1 이름 = '이후 🚀';", "- 9 before\n+ 9 after\n 10 context",
  "-1 const  timeout = 1000;\n+1 const timeout = 5000;", "-1 same content  \n+1 same content",
];
for (let i=0;i<150;i++) {
  const line=()=>Array.from({length:random()%12},()=>["foo","bar","이전","이후","😀","🚀","café"," ","  ",";","(",")"][random()%12]).join("");
  wordInputs.push(`-1 ${line()}\n+1 ${line()}`);
}
const words=wordInputs.map(input=>({input,expected:coloredDiff(input,theme)}));
const changes=[{toolCallId:"a/1",tool:"edit",path:"f",kind:"edit",diff:"-1 before\n+1 after"}];
const persisted=[{piCodemodeDiff:{version:1,changes}}, {piCodemodeDiff:{version:2,changes}}, {piCodemodeDiff:{version:1,changes:[{...changes[0],beforeBytes:null}]}}, {piCodemodeDiff:{version:1,changes:[{...changes[0],diff:"x".repeat(65537)}]}}].map(data=>({data,expected:readChanges(data)??null}));
writeFileSync(new URL("../pig/testdata/typescript.json",import.meta.url),JSON.stringify({diffs:pairs.map(([old,newText])=>({old,new:newText,expected:generateDiffString(old,newText).diff})),writes,words,persisted},null,2)+"\n");
