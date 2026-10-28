/**
 * 生成 app/src/renderer/usd/ 下的三份「打过补丁的 three USD 加载器」。
 *
 * 为什么不用 node_modules 里的原版：
 *   1. USDCParser（crate 二进制）不认 ReferenceListOp / PayloadListOp —— 真实资产
 *      （Omniverse / Isaac Sim 导出的 .usd）的内容全在 payload 里，原版解析出来是空场景；
 *   2. USDAParser 只认 `prepend references`，不认 `references = @x@` / `over` 图元；
 *   3. USDComposer 里材质没有名字（预览器的材质分组识别不出来）、法线强度被放大一倍、
 *      ORM 打包图不做 AO 还原、没有绑定时会拿根目录第一个材质套给所有网格（串材质）、
 *      每次引用都重新组合一遍（Isaac 资产一个几何文件被引用十几次 → 卡死）。
 *
 * 用法：node devtest/usd/make-vendor.mjs        （three 升级后重跑一遍即可）
 * 生成的文件是源码，要一起提交。
 */
import fs from 'node:fs';
import path from 'node:path';

const SRC = 'app/node_modules/three/examples/jsm/loaders/usd';
const OUT = 'app/src/renderer/usd';

const HEADER = (name) => `/* eslint-disable */
// 由 devtest/usd/make-vendor.mjs 从 three/examples/jsm/loaders/usd/${name} 生成并打补丁。
// 不要手改：改补丁请改 make-vendor.mjs 后重跑。
`;

function fail(msg) { throw new Error('[make-vendor] ' + msg); }

function replaceBetween(src, startMark, endMark, repl, label) {
  const i = src.indexOf(startMark);
  if (i < 0) fail('anchor start not found: ' + label);
  const j = src.indexOf(endMark, i + startMark.length);
  if (j < 0) fail('anchor end not found: ' + label);
  return src.slice(0, i) + repl + src.slice(j);
}

function replaceOnce(src, needle, repl, label) {
  const i = src.indexOf(needle);
  if (i < 0) fail('needle not found: ' + label);
  if (src.indexOf(needle, i + needle.length) >= 0) fail('needle not unique: ' + label);
  return src.slice(0, i) + repl + src.slice(i + needle.length);
}

// ---------------------------------------------------------------- USDAParser
function patchUsdaParser() {
  let t = fs.readFileSync(path.join(SRC, 'USDAParser.js'), 'utf8');

  t = replaceOnce(t,
    "const DEF_MATCH_REGEX = /^def\\s+(?:(\\w+)\\s+)?\"?([^\"]+)\"?$/;",
    "const DEF_MATCH_REGEX = /^def\\s+(?:(\\w+)\\s+)?\"?([^\"]+)\"?$/;\n// 补丁新增：over / class 图元（Omniverse 的层大量用 over 做组合覆盖，没有 typeName）\nconst OVER_MATCH_REGEX = /^(?:over|class|inherits)\\s+\"?([^\"]+)\"?$/;",
    'usda DEF_MATCH_REGEX');

  // references / payload：原来只认 `prepend references`
  const refBlock = `			// 补丁：references / payload 的所有写法都收（\`references = @x@</P>\`、
			// \`prepend references\`、数组形式、以及 payload；原来只认 prepend references）
			if ( key === 'references' || key === 'prepend references' || key === 'append references' ||
				key === 'payload' || key === 'prepend payload' || key === 'append payload' ) {

				const rawRef = data[ key ];
				const list = Array.isArray( rawRef ) ? rawRef : [ rawRef ];
				const norm = [];
				for ( const item of list ) {

					if ( item === undefined || item === null ) continue;
					const str = String( item );
					if ( /@[^@]+@/.test( str ) ) norm.push( str );

				}

				if ( norm.length > 0 ) {

					const bucket = key.indexOf( 'payload' ) >= 0 ? 'payload' : 'references';
					primFields[ bucket ] = ( primFields[ bucket ] || [] ).concat( norm );

				}

				continue;

			}

`;
  t = replaceBetween(t,
    "if ( key === 'prepend references' )",
    "if ( key === 'variants' )",
    refBlock,
    'usda references block');

  // walkTree: over / class 图元
  t = replaceOnce(t,
    "				const defMatch = key.match( DEF_MATCH_REGEX );\n				if ( defMatch ) {\n\n					const typeName = defMatch[ 1 ] || '';\n					const name = defMatch[ 2 ];",
    "				// 补丁：over / class 也算图元（无类型），否则带 references 的 over 会被整段丢掉\n				const overMatch = key.match( OVER_MATCH_REGEX );\n				const defMatch = overMatch ? null : key.match( DEF_MATCH_REGEX );\n				if ( defMatch || overMatch ) {\n\n					const typeName = defMatch ? ( defMatch[ 1 ] || '' ) : '';\n					const name = defMatch ? defMatch[ 2 ] : overMatch[ 1 ];",
    'usda walkTree over');

  t = replaceOnce(t,
    "			if ( key.startsWith( 'rel ' ) ) {\n\n				const relName = key.slice( 4 );",
    "			// 补丁：relationship 的写法有好几种（rel / prepend rel / append rel），原来只认 'rel '\n			// —— Omniverse 层里清一色是 `prepend rel material:binding = <...>`，漏了就等于材质全丢\n			const relMatch = key.match( /^(?:(?:prepend|append|add|delete)\\s+)?rel\\s+(.+)$/ );\n			if ( relMatch ) {\n\n				const relName = relMatch[ 1 ].trim();",
    'usda rel prefix');

  // 补丁：属性的「限定词」前缀（prepend / append / custom / uniform …）
  // 原版只吃掉 uniform，于是 `prepend color3f inputs:diffuseColor.connect = <...>` 被解析成
  // 属性名 "color3f inputs:diffuseColor" —— 连线上不去，贴图全丢（Omniverse 层全是这种写法）
  t = replaceOnce(t,
    "			const attrMatch = key.match( ATTR_MATCH_REGEX );",
    "			// 补丁：先剥掉 prepend/append/add/custom/uniform 之类限定词再匹配类型\n			const keyNorm = key.replace( /^(?:(?:prepend|append|add|delete|reorder|spline|uniform|varying|custom|config)\\s+)+/i, '' );\n			const attrMatch = keyNorm.match( ATTR_MATCH_REGEX );",
    'usda attr qualifier');

  // parseText: ':' 分支只处理 timeSamples 的数字键；否则 `token outputs:displacement (` 这类
  // 「带 metadata 的属性声明」会被当成字典项吞掉，紧跟的 `)` 把括号栈弹穿 → 整个文件解析崩
  t = replaceOnce(t,
    "			} else if ( line.includes( ':' ) && ! line.includes( '=' ) ) {",
    "			} else if ( line.includes( ':' ) && ! line.includes( '=' ) && /^[\\d.]+\\s*:/.test( line.trim() ) ) {",
    'usda colon branch guard');
  t = replaceOnce(t,
    "			} else if ( line.endsWith( ')' ) ) {\n\n				stack.pop();\n\n				target = stack[ stack.length - 1 ];",
    "			} else if ( line.endsWith( ')' ) ) {\n\n				// 补丁：括号栈见底就不要再弹（原版会把 target 变成 undefined，后面整段崩）\n				if ( stack.length > 1 ) stack.pop();\n\n				target = stack[ stack.length - 1 ] || root;",
    'usda close paren guard');

  fs.writeFileSync(path.join(OUT, 'USDAParser.js'), HEADER('USDAParser.js') + t, 'utf8');
}

// ---------------------------------------------------------------- USDCParser
function patchUsdcParser() {
  let t = fs.readFileSync(path.join(SRC, 'USDCParser.js'), 'utf8');

  const listOp = `			// 补丁新增：ReferenceListOp / PayloadListOp
			// 真实资产（Omniverse / Isaac Sim / Houdini 导出的 .usd）把几何与材质放在
			// payload / reference 指向的其它层里，原版这里直接 return null → 组合出空场景。
			// 布局（与 PathListOp 相同的 list-op 头）：
			//   u8  flags（0x02 explicit / 0x04 add / 0x08 delete / 0x10 reorder /
			//            0x20 prepend / 0x40 append）
			//   每个存在的列表：u64 个数，随后每项
			//   项：u32 assetPath（this.strings 下标）+ u32 primPath（this.paths 下标）
			//       + f64 layerOffset + f64 layerScale
			case TypeEnum.ReferenceListOp:
			case TypeEnum.PayloadListOp: {

				const flags = reader.readUint8();

				const readRefList = () => {

					const count = reader.readUint64();
					const items = [];

					for ( let i = 0; i < count; i ++ ) {

						const strIdx = reader.readUint32();
						const pathIdx = reader.readUint32();
						const offset = reader.readFloat64();
						const scale = reader.readFloat64();

						const tokIdx = this.strings ? this.strings[ strIdx ] : strIdx;
						const assetPath = this.tokens[ tokIdx ] || '';
						const primPath = this.paths[ pathIdx ] || '';

						items.push( { assetPath, primPath, layerOffset: offset, layerScale: scale } );

					}

					return items;

				};

				const items = [];

				if ( flags & 0x02 ) items.push( ...readRefList() );
				if ( flags & 0x04 ) items.push( ...readRefList() );
				if ( flags & 0x20 ) items.push( ...readRefList() );
				if ( flags & 0x40 ) items.push( ...readRefList() );
				if ( flags & 0x08 ) readRefList();
				if ( flags & 0x10 ) readRefList();

				return items;

			}

`;

  t = replaceOnce(t, "			case TypeEnum.PathListOp: {", listOp + "			case TypeEnum.PathListOp: {", 'usdc PathListOp anchor');

  // 2) 压缩路径表：第二个 u64 是「编码条目数」而不是重复的 numPaths
  t = replaceOnce(t,
    "			reader.readUint64(); // Read duplicate numPaths value (matches numPaths above)",
    `			// 补丁：第二个 u64 不是「重复的 numPaths」，而是压缩路径表里的条目数
			// （实测 = numPaths - 1：根 '/' 不进编码表）。原版拿 numPaths 当三个数组的元素数，
			// 而每元素占 2 bit 的码表长度是 ceil(n/4) 字节 —— 16/17、20/21 这种差一个
			// 正好跨字节边界的文件，整个路径表会解成乱码（Toaster / CoffeeMachine 就是这样）。
			const numEncodedPaths = Number( reader.readUint64() ) || numPaths;`,
    'usdc paths header');

  const compCount = t.split('				numPaths\n			);').length - 1;
  if (compCount !== 3) fail(`expected 3 decompressIntegers32(numPaths) calls, found ${compCount}`);
  t = t.split('				numPaths\n			);').join('				numEncodedPaths\n			);');

  fs.writeFileSync(path.join(OUT, 'USDCParser.js'), HEADER('USDCParser.js') + t, 'utf8');
}

// --------------------------------------------------------------- USDComposer
function patchComposer() {
  let t = fs.readFileSync(path.join(SRC, 'USDComposer.js'), 'utf8');

  // 1) 材质带名字（预览器按「名字 + 贴图签名」分组，没名字就只能一格一格列出来）
  //    + 材质只在被引用层里时，去那一层套材质（Omniverse 的 VisualMaterials 只是引用 materials.usda）
  t = replaceOnce(t,
    "	_applyMaterial( material, materialPath ) {\n",
    `	_applyMaterial( material, materialPath ) {

		// 补丁：把 USD 材质名带出来（预览器的材质分组/贴图覆盖都按名字走）
		if ( materialPath && ! material.name ) {

			material.name = String( materialPath ).split( '/' ).pop();

		}

		// 补丁：材质本身只带 references（指向 materials.usda 里的真材质）时，
		// 本地这层找不到它的 shader —— 去被引用的那一层，用它自己的索引把材质套上。
		const ownShaders = this.shadersByMaterialPath.get( materialPath );
		if ( ( ! this.specsByPath[ materialPath ] || ! ownShaders || ownShaders.length === 0 ) &&
			this._applyExternalMaterial( material, materialPath ) ) {

			return;

		}
`,
    'composer _applyMaterial');

  // 1b) 外部层材质解析 + 按层缓存的「只建索引」composer
  t = replaceOnce(t,
    "	_buildMaterialForPath( materialPath ) {\n",
    `	/** 只建索引的 composer，按「层 URL」缓存 —— 用来套被引用层里的材质 */
	_layerIndexer( url, layer ) {

		const cache = this.assets.__indexers || ( this.assets.__indexers = new Map() );
		let idx = cache.get( url );
		if ( idx ) return idx;

		idx = new USDComposer( this.manager );
		idx.specsByPath = layer.specsByPath;
		idx.assets = this.assets;
		idx.externalVariantSelections = {};
		idx.basePath = String( url ).slice( 0, String( url ).lastIndexOf( '/' ) + 1 );
		idx.textureCache = {};
		idx.texturePromises = [];
		idx.skinnedMeshes = [];
		idx.skeletons = {};
		idx._buildIndexes();
		cache.set( url, idx );
		return idx;

	}

	/**
	 * 材质 prim 只有 references（典型：/Instances/x/VisualMaterials/m_wood -> @materials.usda@</Materials/m_wood>）：
	 * 找到它所在的层，用那层的索引把材质套到这个 material 上。
	 */
	_applyExternalMaterial( material, materialPath ) {

		if ( ! materialPath || ! this.assets ) return false;
		const spec = this.specsByPath[ materialPath ];
		if ( ! spec ) return false;

		const refs = this._getReferences( spec );
		if ( refs.length === 0 ) return false;

		const match = String( refs[ 0 ] ).match( /@([^@]+)@(?:<([^>]+)>)?/ );
		if ( ! match ) return false;

		const url = this._resolveFilePath( match[ 1 ] );
		const layer = this.assets[ url ];
		if ( ! layer || ! layer.specsByPath ) return false;

		const targetPath = match[ 2 ] || materialPath;
		if ( ! layer.specsByPath[ targetPath ] ) return false;

		const idx = this._layerIndexer( url, layer );
		idx._applyMaterial( material, targetPath );

		// 贴图是在那一层的 basePath 下解析的，promise 要并到调用方，否则等待会漏
		if ( idx.texturePromises && idx.texturePromises.length ) {

			this.texturePromises.push( ...idx.texturePromises.splice( 0 ) );

		}

		if ( ! material.name ) material.name = String( targetPath ).split( '/' ).pop();
		return true;

	}

	/**
	 * 引用进来的网格：subset（多材质）的材质绑定常常写在「引用它的那一层」里
	 * （over 图元 + material:binding），要在本层重新套一遍，否则整块都是默认白材质。
	 */
	_applySubsetMaterialOverrides( mesh, primPath ) {

		if ( ! mesh || ! primPath ) return;

		const names = mesh.userData?.subsetNames;
		if ( Array.isArray( mesh.material ) && Array.isArray( names ) && names.length ) {

			const mats = mesh.material.slice();
			let changed = false;
			// 覆盖可能写在两处：引用图元本身上，或它下面同名网格的 over 上
			const selfName = mesh.userData?.primName || '';

			for ( let i = 0; i < names.length; i ++ ) {

				const candidates = [
					primPath + '/' + names[ i ],
					selfName ? primPath + '/' + selfName + '/' + names[ i ] : null
				].filter( Boolean );

				let target = null;
				for ( const candidate of candidates ) {

					target = this._getMaterialBindingTarget( candidate );
					if ( target ) break;

				}

				if ( ! target ) continue;
				mats[ i ] = this._buildMaterialForPath( target );
				changed = true;

			}

			if ( changed ) mesh.material = mats;
			return;

		}

		// 单材质：绑定可能写在这块几何自己的 over 图元上
		const selfName = mesh.userData?.primName || mesh.name;
		if ( ! selfName ) return;

		const target = this._getMaterialBindingTarget( primPath + '/' + selfName );
		if ( target ) mesh.material = this._buildMaterialForPath( target );

	}

	_buildMaterialForPath( materialPath ) {
`,
    'composer external material');

  // 2) _getReferences：支持数组 / {assetPath, primPath}
  const refsStart = "	_getReferences( spec ) {";
  const refsEnd = "	/**\n	 * Resolve an attribute's authored value";
  const newRefs = `	_getReferences( spec ) {

		// 补丁：原来只取第 0 个，且只认字符串。现在：
		//  · references / payload 都收（数组、字符串、{assetPath, primPath} 都行）
		//  · crate 解析出来的 primPath 还原成 "@file@</Prim>"
		const results = [];

		const push = ( value ) => {

			if ( value === undefined || value === null ) return;

			if ( typeof value === 'string' ) {

				if ( ! /@[^@]+@/.test( value ) ) return;
				results.push( value.trim() );
				return;

			}

			const assetPath = value.assetPath || value.path || '';
			if ( ! assetPath ) return;

			let primPath = value.primPath || value.targetPath || '';
			if ( primPath === assetPath ) primPath = '';
			results.push( '@' + assetPath + '@' + ( primPath ? '<' + primPath + '>' : '' ) );

		};

		const asList = ( v ) => ( Array.isArray( v ) ? v : [ v ] );

		if ( spec.fields.references ) asList( spec.fields.references ).forEach( push );
		if ( results.length === 0 && spec.fields.payload ) asList( spec.fields.payload ).forEach( push );

		return results;

	}

`;
  t = replaceBetween(t, refsStart, refsEnd, newRefs, 'composer _getReferences');

  // 3) 引用结果记忆化：Isaac 类资产同一个几何层被引用十几次，原版每次都全量重组
  t = replaceOnce(t,
    "	_resolveReference( refValue, localVariants = {} ) {\n",    `	_resolveReference( refValue, localVariants = {} ) {

		// 补丁：记忆化。原版每遇到一个引用就把被引用的层整份重新组合一次
		// （BeverageStation 的 geometries.usd 被引用 10+ 次），既慢又会重复建材质。
		// 缓存挂在 this.assets 上，嵌套 composer 共用同一份。
		const memo = this.assets.__refCache || ( this.assets.__refCache = new Map() );
		const memoMatch = String( refValue || '' ).match( /@([^@]+)@(?:<([^>]+)>)?/ );
		const memoKey = memoMatch
			? this._resolveFilePath( memoMatch[ 1 ] ) + '|' + ( memoMatch[ 2 ] || '' ) + '|' + JSON.stringify( localVariants || {} )
			: null;

		if ( memoKey && memo.has( memoKey ) ) {

			const hit = memo.get( memoKey );
			return hit ? hit.clone( true ) : null;

		}

		const resolved = this._resolveReferenceUncached( refValue, localVariants );

		if ( memoKey ) memo.set( memoKey, resolved );

		// clone() 共享 geometry / material，等于真正的实例化，代价可以忽略
		return resolved ? resolved.clone( true ) : null;

	}

	_resolveReferenceUncached( refValue, localVariants = {} ) {
`,
    'composer _resolveReference');

  // 4) 没有绑定时「拿根目录第一个材质套上去」改成只有唯一材质时才用（否则就是串材质）
  const fallbackNeedle = `		if ( ! materialPath ) {

			// Use material index for O(1) lookup instead of O(n) iteration
			const meshParts = meshPath.split( '/' );
			const rootPath = '/' + meshParts[ 1 ];

			const materialsInRoot = this.materialsByRoot.get( rootPath );

			if ( materialsInRoot ) {

				for ( const path of materialsInRoot ) {

					if ( path.startsWith( rootPath + '/Looks/' ) ||
						path.startsWith( rootPath + '/Materials/' ) ) {

						materialPath = path;
						break;

					}

				}

			}

		}
`;
  const fallbackRepl = `		if ( ! materialPath ) {

			// 补丁：原版会把「根目录下第一个 Looks/Materials 材质」套给所有没绑定的网格 ——
			// 多材质资产里这就是串材质（A 部件的贴图跑到 B 部件上）。
			// 现在只在整层确实只有一个材质时才这样兜底（那时不可能串），否则留默认材质。
			const allMaterials = [];
			for ( const path in this.specsByPath ) {

				if ( this.specsByPath[ path ].fields.typeName === 'Material' ) allMaterials.push( path );

			}

			if ( allMaterials.length === 1 ) materialPath = allMaterials[ 0 ];

		}
`;
  t = replaceOnce(t, fallbackNeedle, fallbackRepl, 'composer material fallback');

  // 4b) 带 <primPath> 的引用只组合那一个子树
  const refBlockStart = "\t\t// If it's specsByPath data, compose it\n\t\tif ( referencedData.specsByPath ) {";
  const refBlockEnd = "\t\t// If it's already a Three.js Group (legacy support), clone it";
  const refBlockNew = `		// If it's specsByPath data, compose it
		if ( referencedData.specsByPath ) {

			const newBasePath = this._getBasePath( resolvedPath );

			// 补丁：带 <primPath> 的引用只组合那一个子树。
			// 原版是在整份组合结果里找「同名直接子节点」，找不到就把整份都返回 ——
			// Isaac 类资产（payloads/geometries.usd 里一条条 /Geometries/x）因此会把整份
			// 几何塞进每一个引用它的图元：网格成倍重复，材质也对不上。
			if ( primPath ) {

				const composer = new USDComposer( this.manager );
				composer.specsByPath = referencedData.specsByPath;
				composer.assets = this.assets;
				composer.externalVariantSelections = mergedVariants;
				composer.basePath = newBasePath;
				composer.textureCache = {};
				composer.texturePromises = [];
				composer.skinnedMeshes = [];
				composer.skeletons = {};
				composer._buildIndexes();

				const cleanPath = String( primPath ).replace( /<|>/g, '' );
				const slash = cleanPath.lastIndexOf( '/' );
				const parentPath = slash > 0 ? cleanPath.slice( 0, slash ) : '/';
				const childName = cleanPath.slice( slash + 1 );

				// 只让 _buildHierarchy 建这一个子节点（其余层级照旧，子节点要往下递归）
				const filtered = new Map( composer.childrenByPath );
				filtered.set( parentPath, [ { name: childName, path: cleanPath } ] );
				composer.childrenByPath = filtered;

				const originalVariantPaths = composer._getVariantPaths.bind( composer );
				composer._getVariantPaths = ( p ) => ( p === parentPath ? [] : originalVariantPaths( p ) );

				const wrapper = new Group();
				composer._buildHierarchy( wrapper, parentPath );

				if ( composer.texturePromises.length ) this.texturePromises.push( ...composer.texturePromises );

				if ( wrapper.children.length === 0 ) {

					// 目标 prim 不存在（引用写错）：退回整份组合，至少看得到东西
					const fallback = new USDComposer( this.manager );
					const group = fallback.compose( referencedData, this.assets, mergedVariants, newBasePath );
					if ( fallback.texturePromises.length ) this.texturePromises.push( ...fallback.texturePromises );
					return group;

				}

				return wrapper;

			}

			const composer = new USDComposer( this.manager );
			const composedGroup = composer.compose( referencedData, this.assets, mergedVariants, newBasePath );
			if ( composer.texturePromises.length ) this.texturePromises.push( ...composer.texturePromises );
			return composedGroup;

		}

`;
  t = replaceBetween(t, refBlockStart, refBlockEnd, refBlockNew, 'composer reference subtree');

  // 5) 法线贴图强度：USD 的 scale(2)+bias(-1) 是 [0,1]→[-1,1] 的标准解码，
  //    three 的 normalMap 本来就这么解，直接拿 scale 当 normalScale 会加倍强度
  t = replaceOnce(t,
    `		// Apply normal map scale from UsdUVTexture scale input
		if ( material.normalMap && material.normalMap.userData.scale ) {

			const scale = material.normalMap.userData.scale;
			// UsdUVTexture scale is float4 (r,g,b,a), use first two components for normalScale
			material.normalScale = new Vector2( scale[ 0 ], scale[ 1 ] );

		}
`,
    `		// 补丁：UsdUVTexture 的 scale/bias 是「采样值 * scale + bias」，
		// 法线贴图最常见的写法是 scale=(2,2,2,2) bias=(-1,-1,-1,-1)，也就是把 [0,1]
		// 解码到 [-1,1] —— 这件事 three 的 normalMap 已经做了，所以 normalScale 应该取
		// scale/2（标准写法即 1,1），直接拿 scale 会让法线强度翻倍、看起来像另一张图。
		if ( material.normalMap && material.normalMap.userData.scale ) {

			const scale = material.normalMap.userData.scale;
			material.normalScale = new Vector2( scale[ 0 ] / 2, scale[ 1 ] / 2 );

		}
`,
    'composer normalScale');

  // 6) ORM 打包图：粗糙/金属来自 G/B，AO 在 R 上但 USD 里常常不单独连 occlusion
  t = replaceOnce(t,
    "		// Occlusion\n		applyTexture( 'inputs:occlusion', 'aoMap', NoColorSpace, null );\n",
    `		// Occlusion
		applyTexture( 'inputs:occlusion', 'aoMap', NoColorSpace, null );

		// 补丁：ORM / ORMS 打包图里 R 通道就是 AO，USD 材质常常不单独连 inputs:occlusion，
		// 这时把同一张贴图补到 aoMap（three 的 aoMap 正好取 R 通道）。
		if ( ! material.aoMap && material.roughnessMap && material.roughnessMap === material.metalnessMap ) {

			material.aoMap = material.roughnessMap;
			material.aoMapIntensity = 1;

		}
`,
    'composer aoMap from ORM');

  // 7) GeomSubset 记下自己的 prim 路径（回查引用层里的 subset 材质覆盖要用）
  t = replaceOnce(t,
    "			subsets.push( {\n				name: p.split( '/' ).pop(),\n				indices: indices,\n				materialPath: materialPath\n			} );",
    "			subsets.push( {\n				name: p.split( '/' ).pop(),\n				path: p,\n				indices: indices,\n				materialPath: materialPath\n			} );",
    'composer geomSubset path');

  // 8) 网格上记下 subset 名字 / 自己的 prim 路径
  t = replaceOnce(t,
    "		mesh.name = path.split( '/' ).pop();\n		this.applyTransform( mesh, spec.fields, attrs );",
    `		// 补丁：把 GeomSubset 名字与自身 prim 路径记在网格上 ——
		// 引用层里的「subset 材质覆盖」要靠它回查（见 _applySubsetMaterialOverrides）
		mesh.userData.primPath = path;
		mesh.userData.primName = path.split( '/' ).pop();
		if ( Array.isArray( material ) && material.length > 0 ) {

			mesh.userData.subsetNames = geomSubsets.map( ( s ) => s.name );

		}

		mesh.name = path.split( '/' ).pop();
		this.applyTransform( mesh, spec.fields, attrs );`,
    'composer mesh userData');

  // 9) 单一网格合并进引用它的图元后，把引用层里的 subset 材质覆盖套一遍
  t = replaceOnce(t,
    "							// Apply material binding from the referencing prim if present\n							this._applyMaterialBinding( singleMesh, path );",
    "							// Apply material binding from the referencing prim if present\n							this._applyMaterialBinding( singleMesh, path );\n\n							// 补丁：subset（多材质）的绑定多数写在引用层里，这里按名字回查一遍\n							this._applySubsetMaterialOverrides( singleMesh, path );",
    'composer subset override call');

  fs.writeFileSync(path.join(OUT, 'USDComposer.js'), HEADER('USDComposer.js') + t, 'utf8');
}

fs.mkdirSync(OUT, { recursive: true });
patchUsdaParser();
patchUsdcParser();
patchComposer();
for (const f of ['USDAParser.js', 'USDCParser.js', 'USDComposer.js']) {
  const st = fs.statSync(path.join(OUT, f));
  console.log('wrote', path.join(OUT, f), st.size, 'bytes');
}
