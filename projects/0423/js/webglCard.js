var glbComponentInfo = {
   5120: [Int8Array, 1],
   5121: [Uint8Array, 1],
   5122: [Int16Array, 2],
   5123: [Uint16Array, 2],
   5125: [Uint32Array, 4],
   5126: [Float32Array, 4],
};

var glbTypeSize = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT4: 16 };

var glbNodeMatrix = node => {
   if (node.matrix)
      return node.matrix.slice();

   let q = node.rotation ?? [0,0,0,1];
   let [x,y,z,w] = q;
   let rotation = [
      1-2*y*y-2*z*z, 2*x*y+2*z*w,   2*x*z-2*y*w,   0,
      2*x*y-2*z*w,   1-2*x*x-2*z*z, 2*y*z+2*x*w,   0,
      2*x*z+2*y*w,   2*y*z-2*x*w,   1-2*x*x-2*y*y, 0,
      0,               0,               0,               1,
   ];
   return mxm(move(node.translation ?? [0,0,0]),
              mxm(rotation, scale(node.scale ?? [1,1,1])));
}

var loadGLB = async (url, canvas) => {
   let arrayBuffer = await fetch(url).then(response => {
      if (! response.ok)
         throw Error(`Could not load ${url}: ${response.status}`);
      return response.arrayBuffer();
   });
   let data = new DataView(arrayBuffer);
   if (data.getUint32(0, true) != 0x46546c67 || data.getUint32(4, true) != 2)
      throw Error(`${url} is not a glTF 2.0 binary file`);

   let json, binOffset, offset = 12;
   while (offset < data.byteLength) {
      let length = data.getUint32(offset, true);
      let type = data.getUint32(offset + 4, true);
      let start = offset + 8;
      if (type == 0x4e4f534a)
         json = JSON.parse(new TextDecoder().decode(new Uint8Array(arrayBuffer, start, length)).trim());
      if (type == 0x004e4942)
         binOffset = start;
      offset = start + length;
   }
   if (! json || binOffset === undefined)
      throw Error(`${url} does not contain JSON and binary chunks`);

   let accessorData = index => {
      let accessor = json.accessors[index];
      let view = json.bufferViews[accessor.bufferView];
      let [ArrayType, bytes] = glbComponentInfo[accessor.componentType];
      let size = glbTypeSize[accessor.type];
      let byteOffset = binOffset + (view.byteOffset ?? 0) + (accessor.byteOffset ?? 0);
      let packedStride = bytes * size;
      let stride = view.byteStride ?? packedStride;
      if (stride == packedStride)
         return new ArrayType(arrayBuffer, byteOffset, accessor.count * size);

      let result = new ArrayType(accessor.count * size);
      let source = new DataView(arrayBuffer);
      let readers = {
         5120: 'getInt8', 5121: 'getUint8', 5122: 'getInt16',
         5123: 'getUint16', 5125: 'getUint32', 5126: 'getFloat32',
      };
      let reader = readers[accessor.componentType];
      for (let i = 0 ; i < accessor.count ; i++)
         for (let j = 0 ; j < size ; j++)
            result[i * size + j] = source[reader](byteOffset + i * stride + j * bytes, true);
      return result;
   }

   while (! canvas.gl)
      await new Promise(resolve => setTimeout(resolve, 20));

   let context = canvas.gl;
   let imagePromises = (json.images ?? []).map(image => new Promise((resolve, reject) => {
      let view = json.bufferViews[image.bufferView];
      let bytes = new Uint8Array(arrayBuffer, binOffset + (view.byteOffset ?? 0), view.byteLength);
      let objectURL = URL.createObjectURL(new Blob([bytes], { type: image.mimeType }));
      let element = new Image();
      element.onload = () => { URL.revokeObjectURL(objectURL); resolve(element); };
      element.onerror = reject;
      element.src = objectURL;
   }));
   let images = await Promise.all(imagePromises);

   images.forEach((image, index) => {
      let textureInfo = (json.textures ?? []).find(texture => texture.source == index) ?? {};
      let sampler = json.samplers?.[textureInfo.sampler] ?? {};
      context.activeTexture(context.TEXTURE0 + index);
      context.bindTexture(context.TEXTURE_2D, context.createTexture());
      context.pixelStorei(context.UNPACK_FLIP_Y_WEBGL, true);
      context.texImage2D(context.TEXTURE_2D, 0, context.RGBA,
                         context.RGBA, context.UNSIGNED_BYTE, image);
      context.texParameteri(context.TEXTURE_2D, context.TEXTURE_MAG_FILTER,
                            sampler.magFilter ?? context.LINEAR);
      context.texParameteri(context.TEXTURE_2D, context.TEXTURE_MIN_FILTER,
                            sampler.minFilter ?? context.LINEAR_MIPMAP_LINEAR);
      context.texParameteri(context.TEXTURE_2D, context.TEXTURE_WRAP_S,
                            sampler.wrapS ?? context.REPEAT);
      context.texParameteri(context.TEXTURE_2D, context.TEXTURE_WRAP_T,
                            sampler.wrapT ?? context.REPEAT);
      context.generateMipmap(context.TEXTURE_2D);
   });
   context.pixelStorei(context.UNPACK_FLIP_Y_WEBGL, false);

   let primitives = [];
   let upload = (target, values) => {
      let buffer = context.createBuffer();
      context.bindBuffer(target, buffer);
      context.bufferData(target, values, context.STATIC_DRAW);
      return buffer;
   };
   let addMesh = (meshIndex, matrix) => {
      for (let primitive of json.meshes[meshIndex].primitives) {
         if ((primitive.mode ?? 4) != 4)
            continue;
         let material = json.materials?.[primitive.material];
         let pbr = material?.pbrMetallicRoughness ?? {};
         let texture = json.textures?.[pbr.baseColorTexture?.index];
         let indices = accessorData(primitive.indices);
         primitives.push({
            matrix,
            position: upload(context.ARRAY_BUFFER, accessorData(primitive.attributes.POSITION)),
            normal: upload(context.ARRAY_BUFFER, accessorData(primitive.attributes.NORMAL)),
            uv: upload(context.ARRAY_BUFFER, accessorData(primitive.attributes.TEXCOORD_0)),
            indices: upload(context.ELEMENT_ARRAY_BUFFER, indices),
            count: indices.length,
            indexType: primitive.indices === undefined
                       ? context.UNSIGNED_SHORT
                       : json.accessors[primitive.indices].componentType,
            color: (pbr.baseColorFactor ?? [1,1,1,1]).slice(0,3),
            texture: texture?.source ?? -1,
         });
      }
   };
   let visit = (nodeIndex, parentMatrix) => {
      let node = json.nodes[nodeIndex];
      let matrix = mxm(parentMatrix, glbNodeMatrix(node));
      if (node.mesh !== undefined)
         addMesh(node.mesh, matrix);
      for (let child of node.children ?? [])
         visit(child, matrix);
   };
   for (let node of json.scenes[json.scene ?? 0].nodes)
      visit(node, identity());

   return { ready: true, primitives };
}

function WebglCard(ctx) {

   let xy = [0,0], event = '';
   this.mousePress   = pos => { xy = pos; console.log('press'  , xy[0], xy[1]); event = 'press'   };
   this.mouseDrag    = pos => { xy = pos; event = 'drag'    };
   this.mouseClick   = pos => { xy = pos; event = 'click'   };
   this.mouseRelease = pos => { xy = pos; event = 'release' };

   let ball = Shape.sphereMesh(20,10);
   let tube = Shape.glue(Shape.diskMesh(20,-1),
              Shape.glue(Shape.tubeMesh(20),
                         Shape.diskMesh(20,1)));
   let cube = Shape.cubeMesh();

   let tubeX = { triangle_strip: true, data: new Float32Array(tube.data) };
   let tubeY = { triangle_strip: true, data: new Float32Array(tube.data) };
   Shape.transform(tubeX, turnY(Math.PI/2));
   Shape.transform(tubeY, turnX(Math.PI/2));

   this.vertexShader = Shader.defaultVertexShader;
   this.fragmentShader = Shader.shinyFragmentShader;

   autodraw = false;

   let canvas = document.createElement('canvas');
   canvas.width = canvas.height = 500;
   document.body.appendChild(canvas);

   let cg = new Matrix();
   let glbModels = new Map();
   let cardMeshBuffer;

   let useCardMeshBuffer = () => {
      let context = canvas.gl;
      if (! context)
         return;
      if (! cardMeshBuffer)
         cardMeshBuffer = context.createBuffer();
      context.bindBuffer(context.ARRAY_BUFFER, cardMeshBuffer);
      context.bindBuffer(context.ELEMENT_ARRAY_BUFFER, null);
      vertexMap(['aPos',3,'aNor',3,'aUV',2]);
   };

   cg.draw = (mesh, color, s) => {
      let m = perspective(0,0,-5);
      if (! isFirstPlayer())
         m = mxm(m, scale(1,1,-1));
      m = mxm(m, cg.get());
      if (s !== undefined)
         m = mxm(m, scale(s));
      setUniform('Matrix4fv', 'uMF', false, m);
      setUniform('Matrix4fv', 'uMI', false, inverse(m));
      setUniform('3fv', 'uColor', color ?? [1,1,1]);
      setUniform('1i', 'uTexture', -1);
      useCardMeshBuffer();
      drawMesh(mesh);
      return cg;
   }

   cg.drawGLB = (model, color) => {
      let url = typeof model == 'string' ? model : model?.url;
      if (url) {
         if (! glbModels.has(url))
            glbModels.set(url, typeof model == 'object' ? model : {
               url, ready: false, loading: false, primitives: [],
            });
         model = glbModels.get(url);
      }

      if (! model?.ready) {
         if (model?.url && ! model.loading) {
            model.loading = true;
            loadGLB(model.url, canvas)
               .then(loaded => Object.assign(model, loaded))
               .catch(error => {
                  model.loading = false;
                  console.log(`${model.url} load error:`, error);
               });
         }
         return cg;
      }

      let context = canvas.gl;
      let root = cg.get();
      let projection = perspective(0,0,-5);
      if (! isFirstPlayer())
         projection = mxm(projection, scale(1,1,-1));

      for (let primitive of model.primitives) {
         let m = mxm(projection, mxm(root, primitive.matrix));
         setUniform('Matrix4fv', 'uMF', false, m);
         setUniform('Matrix4fv', 'uMI', false, inverse(m));
         setUniform('3fv', 'uColor', color ?? primitive.color);
         setUniform('1i', 'uTexture', color ? -1 : primitive.texture);

         let attribute = (name, size, buffer) => {
            let location = context.getAttribLocation(context.program, name);
            context.bindBuffer(context.ARRAY_BUFFER, buffer);
            context.enableVertexAttribArray(location);
            context.vertexAttribPointer(location, size, context.FLOAT, false, 0, 0);
         };
         attribute('aPos', 3, primitive.position);
         attribute('aNor', 3, primitive.normal);
         attribute('aUV' , 2, primitive.uv);
         context.bindBuffer(context.ELEMENT_ARRAY_BUFFER, primitive.indices);
         context.drawElements(context.TRIANGLES, primitive.count, primitive.indexType, 0);
      }
      setUniform('1i', 'uTexture', -1);
      useCardMeshBuffer();
      return cg;
   }

   gl_start(canvas, this);

   let scene, lastSceneThatWorks;

   this.setScene = src => {
      let newScene;
      try {
         newScene = new Function('cg.identity();' + src);
      } catch (error) {
         console.error('webgl compile error:', error);
         return;
      }
      scene = newScene;
   }

   let startTime = Date.now()/1000;

   let _I = [];

   this.set_I = src => {
      //console.log('setting _I to', src);
      _I = src;
   }

   this.draw = (x,y,w) => {

      if (scene && canvas.gl) {
         gl = canvas.gl;
         gl.useProgram(gl.program);
         let b = ( 'add,cross,dot,ease,evalBezier,'
                 + 'hex,ik,mix,norm,normalize,resize,round,'
                 + 'subtract,round2,transform' ).split(',');
         let m = ( 'PI,abs,acos,asin,atan2,ceil,cos,exp,floor,' +
                   'log,max,min,mod,pow,random,' +
                   'round,sign,sin,sqrt,trunc' ).split(',');
         let v = [
            '_X'   , xy[0],
            '_Y'   , xy[1],
            'event', event,
            '_I'   , _I,
            'cg'   , cg,
            'ball' , ball,
            'cube' , cube,
            'tube' , tube,
            'tubeX', tubeX,
            'tubeY', tubeY,
            'tubeZ', tube,
            'time' , Date.now()/1000 - startTime,
         ];
         for (let i = 0 ; i < b.length ; i++ ) window[b[i]] = b[i];
         for (let i = 0 ; i < m.length ; i++ ) window[m[i]] = Math[m[i]];
         for (let i = 0 ; i < v.length ; i+=2) window[v[i]] = v[i+1];

	 window.isIK = false;

         window.IK = (L1,L2,C) => {
           let B = ik([0,0,0],L1,L2,C,[-1,0,0]);
           let BC = subtract(C,B);
	   let s = Math.sign(dot([B[0],0,B[2]],[C[0],0,C[2]]));
           return [ Math.PI-atan2(C[2],C[0]),
                    s * acos(B[1]/norm(B)),
                    -s * acos(dot(B,BC)/(norm(B)*norm(BC))) ];
         }

         let isError = false;
         try {
            scene();
         }
         catch (error) {
            console.error('webgl runtime error:', error);
            isError = true;
         }
         if (isError) {
            if (lastSceneThatWorks)
               scene = lastSceneThatWorks;
         }
         else
            lastSceneThatWorks = scene;

         for (let i = 0 ; i < b.length ; i++ ) delete window[b[i]];
         for (let i = 0 ; i < m.length ; i++ ) delete window[m[i]];
         for (let i = 0 ; i < v.length ; i+=2) delete window[v[i]];

         ctx.drawImage(canvas, x-w/2, y-w/2, w, w);

         if (event == 'release' || event == 'click')
            event = 'up';
      }
      else {
         ctx.fillStyle = '#00a0ff';
         ctx.fillRect(x-w/2, y-w/2, w, w);
      }
      //ctx.strokeStyle = '#000000';
      //ctx.strokeRect(x-w/2, y-w/2, w, w);
   }
}
