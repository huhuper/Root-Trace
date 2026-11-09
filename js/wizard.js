/** 建族谱向导：从「我」开始，逐代往上问祖先、往下问子孙，最后生成只读的关系图。
	需要通过本地启动器（start.py）打开：数据自动保存为 input.js，照片存进 images/，可一键生成 PDF。
	依赖：d3、js/dag*.js、js/familienbaum.js、js/editor.js（MEMBER_FIELDS）、
	      js/wizard_data.js、js/local_server.js
*/
(function() {
	const DRAFT_KEY = "root-trace-wizard-draft";

	// 表单字段沿用 editor.js 的 MEMBER_FIELDS（与 PDF 字段一致），照片单独用上传按钮处理
	const FIELD_INPUTS = {
		name: { type: "text", placeholder: "例如：张三" },
		title: { type: "text" },
		birth_date: { type: "date" },
		lunar_birthday: { type: "text", placeholder: "例如：正月十一" },
		zodiac: { type: "zodiac" },
		death_date: { type: "date", hint: "在世可不填" },
		biography: { type: "textarea", placeholder: "生平事迹、性格、职业、趣事……" }
	};

	// 卡片标题里补充的口语称呼
	const COLLOQUIAL = {
		"祖父": "爷爷", "祖母": "奶奶", "外祖父": "外公", "外祖母": "外婆",
		"曾祖父": "太爷爷", "曾祖母": "太奶奶", "外曾祖父": "太姥爷", "外曾祖母": "太姥姥"
	};

	let state = load_draft() || new_state();
	let titles = {};   // 成员ID -> 默认称谓（每次渲染重新计算）
	let previews = {}; // 成员ID -> 本次会话里上传照片的预览地址
	let graph = null;  // 当前展示的 Familienbaum

	const main = document.getElementById("wizard-main");
	const nav = document.getElementById("wizard-nav");
	const progress = document.getElementById("wizard-progress");
	const header = document.getElementById("wizard-header");
	const graph_view = document.getElementById("graph-view");
	const blocker = document.getElementById("launcher-required");

	// ---------- 草稿（只存文字，照片已经在 images 文件夹里） ----------
	function load_draft() {
		try {
			let text = localStorage.getItem(DRAFT_KEY);
			if (!text) return null;
			let draft = JSON.parse(text);
			if (!draft || draft.version !== 2 || !draft.people || !draft.people[draft.me]) return null;
			return draft;
		} catch (e) {
			return null;
		}
	}

	function save_draft() {
		try {
			localStorage.setItem(DRAFT_KEY, JSON.stringify(state));
		} catch (e) { /* 存储不可用时忽略，向导照常工作 */ }
	}

	function clear_draft() {
		try {
			localStorage.removeItem(DRAFT_KEY);
		} catch (e) { /* 忽略 */ }
	}

	// ---------- 小工具 ----------
	function el(tag, attrs = {}, children = []) {
		let node = document.createElement(tag);
		for (let key in attrs) {
			let value = attrs[key];
			if (value === undefined || value === null || value === false) continue;
			if (key === "class") node.className = value;
			else if (key === "text") node.textContent = value;
			else if (key.startsWith("on")) node.addEventListener(key.slice(2), value);
			else if (value === true) node.setAttribute(key, "");
			else node.setAttribute(key, value);
		}
		for (let child of [].concat(children)) {
			if (child === null || child === undefined || child === false) continue;
			node.append(child instanceof Node ? child : document.createTextNode(String(child)));
		}
		return node;
	}

	function field_label(key) {
		let field = MEMBER_FIELDS.find(f => f.key === key);
		return field ? field.label : key;
	}

	function message(text, kind = "info") {
		return el("p", { class: "message " + kind, text: text });
	}

	function name_of(id) {
		return String((state.people[id] && state.people[id].name) || "").trim();
	}

	/** 例：父亲「欧阳大」 */
	function who(id) {
		let name = name_of(id);
		return (titles[id] || "") + (name ? "「" + name + "」" : "");
	}

	function heading_of(id) {
		let title = titles[id] || "";
		return COLLOQUIAL[title] ? title + "（" + COLLOQUIAL[title] + "）" : title;
	}

	// ---------- 人员卡片 ----------
	function person_card(id, options = {}) {
		let person = state.people[id];
		let card = el("section", { class: "person-card" });
		let head = el("div", { class: "card-head" }, [el("h3", { text: options.heading || heading_of(id) })]);
		if (options.extra) head.append(options.extra);
		if (options.on_remove)
			head.append(el("button", {
				type: "button", class: "link-button danger", text: "删除",
				onclick: options.on_remove
			}));
		card.append(head);

		let body = el("div", { class: "card-body" });
		body.append(photo_picker(person));
		let fields = el("div", { class: "card-fields" });
		fields.append(field_row(person, "name", { required: options.required }));
		if (options.show_sex) fields.append(sex_row(person));
		let more = el("details", { class: "more", open: options.open_more ? true : false }, [
			el("summary", { text: "填写更多信息（可选）" })
		]);
		for (let key of ["title", "birth_date", "lunar_birthday", "zodiac", "death_date", "biography"])
			more.append(field_row(person, key, key === "title" ? { placeholder: titles[id] } : {}));
		fields.append(more);
		body.append(fields);
		card.append(body);
		return card;
	}

	function field_row(person, key, extra = {}) {
		let spec = FIELD_INPUTS[key];
		let id = "f_" + person.id + "_" + key;
		let label_text = key === "title" ? "称谓" : field_label(key) + (extra.required ? "（必填）" : "");
		let update = event => {
			person[key] = event.target.value;
			save_draft();
			if (key === "name") render_progress(); // 填了名字后，后面可能多出新的问题
		};
		let input;
		if (spec.type === "textarea") {
			input = el("textarea", { id: id, rows: 3, placeholder: spec.placeholder, oninput: update });
		} else if (spec.type === "zodiac") {
			input = el("select", { id: id, onchange: update }, [el("option", { value: "", text: "（不填）" })]);
			for (let z of ZODIACS) input.append(el("option", { value: z, text: z }));
		} else {
			input = el("input", {
				id: id, type: spec.type,
				placeholder: extra.placeholder || spec.placeholder,
				oninput: update
			});
		}
		input.value = person[key] || "";
		let row = el("div", { class: "field" }, [el("label", { for: id, text: label_text }), input]);
		if (spec.hint) row.append(el("span", { class: "hint", text: spec.hint }));
		if (key === "title" && extra.placeholder)
			row.append(el("span", { class: "hint", text: "不填则使用「" + extra.placeholder + "」" }));
		return row;
	}

	function sex_row(person) {
		let id = "f_" + person.id + "_sex";
		let select = el("select", {
			id: id,
			onchange: event => {
				person.sex = event.target.value;
				save_draft();
			}
		}, [
			el("option", { value: "", text: "（不填）" }),
			el("option", { value: "M", text: "男" }),
			el("option", { value: "F", text: "女" })
		]);
		select.value = person.sex || "";
		return el("div", { class: "field" }, [
			el("label", { for: id, text: "性别" }), select,
			el("span", { class: "hint", text: "用于推算称谓，例如配偶是「妻子」还是「丈夫」" })
		]);
	}

	function photo_picker(person) {
		let box = el("div", { class: "photo" });
		let img = el("img", { alt: "", class: "photo-preview" });
		let empty = el("div", { class: "photo-empty", text: "暂无照片" });
		let status = el("div", { class: "photo-status" });
		let show = src => {
			img.hidden = !src;
			empty.hidden = !!src;
			if (src) img.src = src;
		};
		img.addEventListener("error", () => show(""));
		show(previews[person.id] || person.image_path);

		let file_id = "photo_" + person.id;
		let file_input = el("input", { type: "file", accept: "image/*", id: file_id, class: "visually-hidden" });
		file_input.addEventListener("change", async () => {
			let file = file_input.files && file_input.files[0];
			if (!file) return;
			status.textContent = "保存中…";
			try {
				let result = await LocalServer.upload_photo(person.id, file);
				person.image_path = result.image_path;
				if (previews[person.id]) URL.revokeObjectURL(previews[person.id]);
				previews[person.id] = URL.createObjectURL(file);
				show(previews[person.id]);
				status.textContent = "已保存到 " + result.image_path;
				save_draft();
			} catch (e) {
				status.textContent = "保存失败：" + e.message;
			}
			file_input.value = "";
		});
		box.append(img, empty, file_input,
			el("label", { for: file_id, class: "button small", text: person.image_path ? "更换照片" : "上传照片" }),
			status);
		return box;
	}

	function rel_select(id, values) {
		let select = el("select", {
			class: "rel-select",
			"aria-label": "关系",
			onchange: event => {
				set_rel(state, id, event.target.value);
				save_draft();
				render(); // 默认称谓（长子、次女……）可能变化
			}
		});
		for (let v of values) select.append(el("option", { value: v, text: v }));
		select.value = state.people[id].rel;
		return select;
	}

	/** 一组可增删的人（兄弟姐妹 / 子女） */
	function person_list(ids, options) {
		let wrap = el("div");
		ids.forEach(id => {
			wrap.append(person_card(id, {
				extra: rel_select(id, options.rels),
				on_remove: () => {
					let note = name_of(id) ? "确定删除「" + name_of(id) + "」吗？他/她的配偶和后代也会一起删除。" : null;
					if (note && !window.confirm(note)) return;
					remove_person(state, id);
					save_draft();
					render();
				}
			}));
		});
		let add_row = el("div", { class: "button-row" });
		for (let rel of options.rels) {
			add_row.append(el("button", {
				type: "button", class: "button",
				text: "+ 添加" + options.rel_names[rel],
				onclick: () => {
					let person = options.add(rel);
					save_draft();
					render();
					let input = document.getElementById("f_" + person.id + "_name");
					if (input) input.focus();
				}
			}));
		}
		wrap.append(add_row);
		return wrap;
	}

	// ---------- 各类页面 ----------
	function render_intro() {
		return el("div", {}, [
			el("h2", { text: "欢迎使用建族谱向导" }),
			el("p", { text: "接下来会从「你」开始，一代一代地问：先往上问父母、祖父母、曾祖父母……再往下问配偶、子女、孙辈……还会问兄弟姐妹一家。" }),
			el("p", { text: "知道多少填多少，任何一页都可以留空跳过；跳过的那一支就不会再继续往下问。" }),
			el("p", { text: "填完后会自动画出家族关系图，数据自动保存到项目里的 input.js，照片保存在 images 文件夹，还可以一键生成族谱 PDF。所有信息只保存在你自己的电脑上。" })
		]);
	}

	function render_me() {
		return el("div", {}, [
			el("h2", { text: "先介绍一下你自己" }),
			el("p", { class: "lead", text: "姓名是必填的，其他信息可以以后再补充。" }),
			person_card(state.me, { heading: "我", required: true, open_more: true, show_sex: true })
		]);
	}

	function render_parents(page) {
		let family = ensure_birth_family(state, page.of);
		save_draft();
		titles = kinship_titles(state);
		let is_me = page.of === state.me;
		return el("div", {}, [
			el("h2", { text: is_me ? "你的父母" : who(page.of) + "的父母" }),
			el("p", { class: "lead", text: "知道多少填多少。留空直接点「下一步」，这一支就不再往上问。" }),
			person_card(family.partners[0]),
			person_card(family.partners[1])
		]);
	}

	function render_siblings() {
		let family = ensure_birth_family(state, state.me);
		let siblings = family.children.filter(id => id !== state.me);
		return el("div", {}, [
			el("h2", { text: "你的兄弟姐妹" }),
			el("p", { class: "lead", text: "按年龄从大到小添加。后面会继续问他们的配偶和子女。没有的话直接点「下一步」。" }),
			person_list(siblings, {
				rels: ["兄", "弟", "姐", "妹"],
				rel_names: { "兄": "哥哥", "弟": "弟弟", "姐": "姐姐", "妹": "妹妹" },
				add: rel => add_sibling(state, rel)
			}),
			siblings.length ? null : message("还没有添加兄弟姐妹。", "info")
		]);
	}

	function render_family(page) {
		let family = ensure_own_family(state, page.of);
		save_draft();
		titles = kinship_titles(state);
		let is_me = page.of === state.me;
		return el("div", {}, [
			el("h2", { text: is_me ? "你的配偶和子女" : who(page.of) + "的配偶和子女" }),
			el("p", { class: "lead", text: "没有的话留空，直接点「下一步」。添加的子女，后面会继续问他们的配偶和子女。" }),
			person_card(family.partners[1]),
			el("h3", { class: "group-title", text: "子女（按年龄从大到小）" }),
			person_list(family.children, {
				rels: ["子", "女"],
				rel_names: { "子": "儿子", "女": "女儿" },
				add: rel => add_child(state, page.of, rel)
			})
		]);
	}

	function render_cover() {
		let suggested = extract_clan(name_of(state.me));
		let preview = el("div", { class: "cover-preview" });
		let update_preview = () => {
			let clan = String(state.cover.clan || "").trim() || suggested || "　";
			let motto = String(state.cover.motto || "").trim() || DEFAULT_MOTTO;
			preview.replaceChildren(
				el("div", { class: "cover-title", text: clan + "氏族谱" }),
				el("div", { class: "cover-motto", text: motto }));
		};
		let input_row = (key, label, placeholder, hint) => {
			let id = "cover_" + key;
			let input = el("input", {
				id: id, type: "text", placeholder: placeholder,
				oninput: event => {
					state.cover[key] = event.target.value;
					save_draft();
					update_preview();
				}
			});
			input.value = state.cover[key] || "";
			return el("div", { class: "field" }, [
				el("label", { for: id, text: label }), input, el("span", { class: "hint", text: hint })
			]);
		};
		update_preview();
		return el("div", {}, [
			el("h2", { text: "族谱封面" }),
			el("p", { class: "lead", text: "这两项会显示在 PDF 族谱的封面上。" }),
			el("section", { class: "person-card" }, [
				input_row("clan", "姓氏", suggested || "例如：欧阳", "不填则使用「" + (suggested || "始祖姓氏") + "」"),
				input_row("motto", "祖训", DEFAULT_MOTTO, "不填则使用「" + DEFAULT_MOTTO + "」")
			]),
			preview
		]);
	}

	const RENDERERS = {
		intro: render_intro,
		me: render_me,
		parents: render_parents,
		siblings: render_siblings,
		family: render_family,
		cover: render_cover
	};

	// ---------- 完成：保存 + 只读关系图 + PDF ----------
	function set_graph_message(...nodes) {
		document.getElementById("graph-message").replaceChildren(...nodes);
	}

	async function render_done() {
		let built = build_input(state);
		let count = Object.keys(built.input.members).length;
		document.getElementById("graph-status").textContent =
			"共 " + count + " 位成员。拖动可平移，滚轮可缩放，点击头像可只看这一支。";
		draw_graph(built.input);
		set_graph_message(message("正在保存 input.js…", "info"));
		try {
			let result = await LocalServer.save_input(built.input);
			set_graph_message(message(
				"已自动保存到项目里的 input.js" +
				(result.backed_up ? "（原来的 input.js 已备份为 input.backup.js）" : "") + "。", "ok"));
		} catch (e) {
			set_graph_message(message("保存失败：" + e.message + "。请确认启动向导的窗口没有关闭。", "error"));
		}
	}

	function draw_graph(input) {
		let container = document.getElementById("graph-canvas");
		container.replaceChildren();
		let width = container.clientWidth || window.innerWidth;
		let height = container.clientHeight || window.innerHeight;
		let svg = d3.select(container).append("svg").attr("width", width).attr("height", height);
		// Familienbaum 会修改传入的数据，这里给它一份副本；不传编辑 div 即为只读模式
		graph = new Familienbaum(JSON.parse(JSON.stringify(input)), svg);
		show_all();
	}

	function show_all() {
		if (!graph) return;
		for (let node of graph.dag_all.nodes()) node.added_data.is_visible = true;
		graph.draw(false);
		fit_to_view();
	}

	function fit_to_view() {
		let nodes = Array.from(graph.dag.nodes());
		if (nodes.length === 0) return;
		// 布局中 node.y 是横向（世代），node.x 是纵向
		let min_x = Math.min(...nodes.map(n => n.y)) - 50;
		let max_x = Math.max(...nodes.map(n => n.y)) + 150; // 右侧留出姓名文字
		let min_y = Math.min(...nodes.map(n => n.x)) - 50;
		let max_y = Math.max(...nodes.map(n => n.x)) + 50;
		let width = +graph.svg.attr("width");
		let height = +graph.svg.attr("height");
		let k = Math.min(width / (max_x - min_x), height / (max_y - min_y), 1.5);
		let tx = width / 2 - k * (min_x + max_x) / 2;
		let ty = height / 2 - k * (min_y + max_y) / 2;
		graph.svg.transition().duration(graph.transition_milliseconds)
			.call(graph.zoom.transform, d3.zoomIdentity.translate(tx, ty).scale(k));
	}

	async function make_pdf() {
		let button = document.getElementById("make-pdf");
		button.disabled = true;
		// 在点击时同步打开新窗口，避免生成完成后再打开被浏览器拦截
		let win = window.open("", "_blank");
		if (win) {
			try {
				win.document.title = "正在生成族谱 PDF…";
				win.document.body.textContent = "正在生成族谱 PDF，请稍候……";
			} catch (e) { /* 忽略 */ }
		}
		set_graph_message(message("正在生成族谱 PDF，人数较多时需要几秒钟……", "info"));
		try {
			await LocalServer.save_input(build_input(state).input);
			let result = await LocalServer.make_pdf();
			if (win && !win.closed) win.location.href = result.url;
			let box = message("已生成族谱 PDF，并保存在项目文件夹里（family_tree.pdf）。", "ok");
			box.append(" ", el("a", { href: result.url, target: "_blank", rel: "noopener", text: "打开 PDF" }));
			set_graph_message(box);
		} catch (e) {
			if (win && !win.closed) win.close();
			set_graph_message(message("生成 PDF 失败：" + e.message, "error"));
		} finally {
			button.disabled = false;
		}
	}

	function restart() {
		if (!window.confirm("确定要清空所有已填写的内容，重新开始吗？\n（已经保存的 input.js 和照片不受影响）")) return;
		clear_draft();
		for (let url of Object.values(previews)) URL.revokeObjectURL(url);
		previews = {};
		state = new_state();
		render();
	}

	// ---------- 导航 ----------
	function current_position() {
		let pages = compute_pages(state);
		let index = pages.findIndex(page => page.key === state.page_key);
		if (index < 0) index = Math.max(0, Math.min(state.page_index || 0, pages.length - 1));
		return { pages, index };
	}

	function go_to(key) {
		state.page_key = key;
		save_draft();
		render();
		window.scrollTo(0, 0);
	}

	function validate(page) {
		if (page.type === "me" && !name_of(state.me)) return "请填写你的姓名。";
		if (page.type === "cover") {
			let built = build_input(state);
			if (built.errors.length) return built.errors.join(" ");
		}
		return "";
	}

	function render_progress() {
		let { pages, index } = current_position();
		// 「欢迎」和「完成」不计入步数
		let total = pages.length - 2;
		progress.replaceChildren(
			el("div", { class: "progress-text", text: index === 0
				? "开始之前"
				: "第 " + index + " 步，共 " + total + " 步（填了新的人，后面会继续追问）" }),
			el("div", { class: "progress-bar" }, [
				el("div", { class: "progress-fill", style: "width:" + Math.min(100, index / total * 100) + "%" })
			]));
	}

	function render_nav(pages, index) {
		let page = pages[index];
		let error = el("div", { class: "nav-error", role: "alert" });
		let back = el("button", {
			type: "button", class: "button", text: "上一步",
			disabled: index === 0,
			onclick: () => go_to(pages[index - 1].key)
		});
		let next_text = page.type === "intro" ? "开始填写" : (page.type === "cover" ? "生成关系图" : "下一步");
		let next = el("button", {
			type: "button", class: "button primary", text: next_text,
			onclick: () => {
				let problem = validate(page);
				if (problem) {
					error.replaceChildren(message(problem, "error"));
					return;
				}
				// 重新计算：刚填的名字可能带出新的页面
				let fresh = compute_pages(state);
				let at = fresh.findIndex(p => p.key === page.key);
				go_to(fresh[Math.min(at + 1, fresh.length - 1)].key);
			}
		});
		nav.replaceChildren(error, el("div", { class: "nav-buttons" }, [back, next]));
	}

	function render() {
		let { pages, index } = current_position();
		let page = pages[index];
		state.page_key = page.key;
		state.page_index = index;
		titles = kinship_titles(state);
		let done = page.type === "done";
		document.body.classList.toggle("graph-mode", done);
		graph_view.hidden = !done;
		main.hidden = done;
		nav.hidden = done;
		header.hidden = done;
		if (done) {
			render_done();
			return;
		}
		graph = null;
		main.replaceChildren(RENDERERS[page.type](page));
		render_progress();
		render_nav(pages, index);
	}

	// ---------- 启动 ----------
	main.addEventListener("input", () => {
		let error = nav.querySelector(".nav-error");
		if (error) error.replaceChildren(); // 用户开始修改，就清掉上次的错误提示
	});
	document.getElementById("back-to-edit").addEventListener("click", () => go_to("cover"));
	document.getElementById("show-all").addEventListener("click", show_all);
	document.getElementById("make-pdf").addEventListener("click", make_pdf);
	document.getElementById("restart").addEventListener("click", restart);

	let resize_timer = null;
	window.addEventListener("resize", () => {
		if (!graph) return;
		clearTimeout(resize_timer);
		resize_timer = setTimeout(() => draw_graph(build_input(state).input), 200);
	});

	// 草稿停在「完成」但数据不完整时，退回封面
	if (state.page_key === "done" && build_input(state).errors.length) state.page_key = "cover";

	LocalServer.ping().then(ok => {
		if (!ok) {
			// 直接双击打开了 HTML：浏览器无法写文件，也无法生成 PDF
			blocker.hidden = false;
			header.hidden = main.hidden = nav.hidden = true;
			return;
		}
		render();
	});
})();
