"use client";

import { useEffect, useId, useRef, useState } from "react";

/* Liquid silk page background: glossy folds of fabric in blues — deep
   navy, royal blue, azure, sky and ice blue — lit by a key light that follows
   the pointer. One fixed layer behind the whole homepage (sidebar and navbar
   included). Domain-warped fbm shaped into ribbons, shaded with wrap diffuse,
   a tight specular, an iridescent sheen and a cyan fresnel rim. The swirl
   drifts up slowly with scroll and dims smoothly once past the hero; CSS
   gradient veils on top keep the UI legible. Rendered at reduced resolution;
   falls back to a blurred CSS wash. */

const VERTEX = `attribute vec2 p;void main(){gl_Position=vec4(p,0.,1.);}`;
const FRAGMENT = `
#ifdef GL_FRAGMENT_PRECISION_HIGH
precision highp float;
#else
precision mediump float;
#endif
uniform vec2 r;   // canvas size, device px
uniform float ps; // canvas px per CSS px
uniform float sc; // scroll offset, CSS px
uniform float t;
uniform vec2 m;
float h(vec2 p){return fract(sin(dot(p,vec2(127.1,311.7)))*43758.5453);}
float n(vec2 p){vec2 i=floor(p),f=fract(p);vec2 u=f*f*(3.-2.*f);
  return mix(mix(h(i),h(i+vec2(1,0)),u.x),mix(h(i+vec2(0,1)),h(i+vec2(1,1)),u.x),u.y);}
float fbm(vec2 p){float v=0.,a=.5;mat2 k=mat2(1.6,1.2,-1.2,1.6);
  for(int i=0;i<4;i++){v+=a*n(p);p=k*p;a*=.5;}return v;}
float field(vec2 p,float s){
  vec2 q=vec2(fbm(p*.9+vec2(0.,s*.8)),fbm(p*.9+vec2(5.2,1.3)-s*.6));
  vec2 w=vec2(fbm(p+2.4*q+vec2(1.7,9.2)+s*.5),fbm(p+2.4*q+vec2(8.3,2.8)-s*.4));
  return fbm(p*.8+2.2*w);
}
float height(vec2 p,float s,out float f){f=field(p,s);return f+.22*sin(f*6.5+s*1.2);}
vec3 iris(float x){
  x=.5+.5*sin(x*6.2831);
  vec3 c0=vec3(.02,.06,.26),c1=vec3(.10,.28,.90),c2=vec3(.16,.52,1.),c3=vec3(.38,.74,1.),c4=vec3(.76,.90,1.);
  x*=4.;
  vec3 c=mix(c0,c1,smoothstep(0.,1.,x));
  c=mix(c,c2,smoothstep(1.,2.,x));
  c=mix(c,c3,smoothstep(2.,3.,x));
  return mix(c,c4,smoothstep(3.,4.,x));
}
void main(){
  float z=1.25/min(r.x,r.y);
  vec2 p=(gl_FragCoord.xy-.5*r)*z+m*.07;
  p.y-=sc*ps*z*.3;
  float s=t*.038+sc*.00025;
  float e=z*2.;
  float f,fx,fy;
  float hc=height(p,s,f);
  float hx=height(p+vec2(e,0.),s,fx);
  float hy=height(p+vec2(0.,e),s,fy);
  vec3 nrm=normalize(vec3(-(hx-hc)/e*.11,-(hy-hc)/e*.11,1.));
  vec3 l=normalize(vec3(-.45+m.x*.5,.55+m.y*.35,.7));
  vec3 v=vec3(0.,0.,1.);
  float wrap=clamp(dot(nrm,l)*.75+.25,0.,1.);
  float fres=pow(1.-clamp(nrm.z,0.,1.),2.2);
  float lit=smoothstep(.15,1.,wrap);
  float x=f*1.6+fres*.8+p.x*.15+s*.12;
  vec3 hue=iris(x);
  vec3 shade=vec3(.008,.022,.075);
  vec3 mid=mix(vec3(.06,.17,.56),hue,.55);
  vec3 col=mix(shade,mid,smoothstep(.0,.55,lit));
  col=mix(col,hue*1.15,smoothstep(.45,1.,lit));
  vec3 rf=reflect(-l,nrm);
  float spec=pow(max(dot(rf,v),0.),70.);
  float sheen=pow(max(dot(rf,v),0.),10.);
  col+=spec*vec3(.92,.97,1.)*1.1;
  col+=sheen*vec3(.5,.75,1.)*.22;
  col+=fres*vec3(.45,.82,1.)*.2*lit;
  col*=smoothstep(-.05,.45,hc);
  float vig=smoothstep(1.6,.2,length(p*vec2(.62,1.)));
  col*=mix(.45,1.,vig);
  col*=mix(1.,.55,smoothstep(0.,r.y/ps*.85,sc));
  col=col/(1.+col*.35);
  gl_FragColor=vec4(pow(col,vec3(.92)),1.);
}`;


export function IridescentBackdrop() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const gl = canvas.getContext("webgl", { antialias: false, premultipliedAlpha: false, powerPreference: "low-power" });
    if (!gl) { setFailed(true); return; }
    const compile = (type: number, source: string) => {
      const shader = gl.createShader(type)!;
      gl.shaderSource(shader, source);
      gl.compileShader(shader);
      return gl.getShaderParameter(shader, gl.COMPILE_STATUS) ? shader : null;
    };
    const vs = compile(gl.VERTEX_SHADER, VERTEX);
    const fs = compile(gl.FRAGMENT_SHADER, FRAGMENT);
    const program = gl.createProgram();
    if (!vs || !fs || !program) { setFailed(true); return; }
    gl.attachShader(program, vs);
    gl.attachShader(program, fs);
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) { setFailed(true); return; }
    gl.useProgram(program);
    const buffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    const loc = gl.getAttribLocation(program, "p");
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
    const uRes = gl.getUniformLocation(program, "r");
    const uTime = gl.getUniformLocation(program, "t");
    const uMouse = gl.getUniformLocation(program, "m");
    const uPs = gl.getUniformLocation(program, "ps");
    const uScroll = gl.getUniformLocation(program, "sc");
    const mouse = { x: 0, y: 0, tx: 0, ty: 0 };
    const onPointer = (event: PointerEvent) => {
      const rect = canvas.getBoundingClientRect();
      mouse.tx = Math.max(-1, Math.min(1, ((event.clientX - rect.left) / rect.width) * 2 - 1));
      mouse.ty = Math.max(-1, Math.min(1, -(((event.clientY - rect.top) / rect.height) * 2 - 1)));
    };
    window.addEventListener("pointermove", onPointer, { passive: true });

    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const scale = Math.min(window.devicePixelRatio || 1, 2) * 0.42;
    const resize = () => {
      const w = Math.max(1, Math.round(canvas.clientWidth * scale));
      const h = Math.max(1, Math.round(canvas.clientHeight * scale));
      if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
      gl.viewport(0, 0, w, h);
      gl.uniform2f(uRes, w, h);
      gl.uniform1f(uPs, w / Math.max(1, canvas.clientWidth));
    };
    const start = performance.now() - 24_000;
    let frame = 0;
    let visible = true;
    const draw = (now: number) => {
      resize();
      mouse.x += (mouse.tx - mouse.x) * 0.035;
      mouse.y += (mouse.ty - mouse.y) * 0.035;
      gl.uniform2f(uMouse, mouse.x, mouse.y);
      gl.uniform1f(uTime, (now - start) / 1000);
      gl.uniform1f(uScroll, window.scrollY);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      if (!reduce && visible) frame = requestAnimationFrame(draw);
    };
    const observer = new IntersectionObserver(([entry]) => {
      const was = visible;
      visible = entry.isIntersecting;
      if (visible && !was && !reduce) frame = requestAnimationFrame(draw);
    });
    observer.observe(canvas);
    const onResize = () => { if (reduce) draw(performance.now()); };
    window.addEventListener("resize", onResize);
    window.addEventListener("scroll", onResize, { passive: true });
    frame = requestAnimationFrame(draw);
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
      window.removeEventListener("resize", onResize);
      window.removeEventListener("scroll", onResize);
      window.removeEventListener("pointermove", onPointer);
      gl.deleteBuffer(buffer);
      gl.deleteProgram(program);
      gl.deleteShader(vs);
      gl.deleteShader(fs);
    };
  }, []);

  return <div className="page-silk" aria-hidden="true">
    {failed ? <div className="page-silk-fallback"/> : <canvas ref={canvasRef}/>}
    <div className="page-silk-veil"/>
  </div>;
}

export function RotatingBadge({ text }: { text: string }) {
  const id = useId().replace(/:/g, "");
  return <div className="hero-badge" aria-hidden="true">
    <svg className="badge-ring" viewBox="0 0 100 100">
      <defs><path id={id} d="M50 50m-38 0a38 38 0 1 1 76 0a38 38 0 1 1-76 0"/></defs>
      <text><textPath href={`#${id}`} textLength="236" lengthAdjust="spacing">{text}</textPath></text>
    </svg>
    <svg className="badge-core" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round"><path d="M5 12h14m-6-6 6 6-6 6"/></svg>
  </div>;
}
