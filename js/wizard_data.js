/** 向导的数据层（v2）：人 + 家庭 的通用结构，支持逐代往上、往下展开。
	不依赖 DOM，可在 node 中直接测试：
	const W = require("./js/wizard_data.js");

	state.families 中每个家庭：{ id, partners: [主方, 配偶], children: [...] }
	- 「出生家庭」：某人作为子女所在的家庭，partners 为 [父, 母]
	- 「自己的家庭」：某人作为 partners[0] 的家庭，partners[1] 为配偶
	名字为空的人视为不存在（页面会预先建好空白占位，ID 固定，照片文件名才能对应）。
*/

const ME_ID = "I500";

const ZODIACS = ["鼠", "牛", "虎", "兔", "龙", "蛇", "马", "羊", "猴", "鸡", "狗", "猪"];

// 与 generate_pdf.py 中 COMPOUND_SURNAMES 一致
const WIZARD_COMPOUND_SURNAMES = [
	"欧阳", "司马", "上官", "皇甫", "诸葛", "东方", "西门", "南宫",
	"司徒", "司空", "夏侯", "慕容", "令狐", "公孙", "宇文", "长孙",
	"尉迟", "端木", "独孤", "赫连", "万俟", "纳兰"
];

const DEFAULT_MOTTO = "慎终追远　民德归厚";

const SIBLING_RELS = { "兄": "M", "弟": "M", "姐": "F", "妹": "F" };
const CHILD_RELS = { "子": "M", "女": "F" };

// ---------- 基本操作 ----------
function empty_person(id, sex = "", rel = "") {
	return {
		id: id,
		sex: sex,           // "M" / "F" / ""（配偶的性别由主方推断）
		rel: rel,           // 兄弟姐妹：兄/弟/姐/妹；子女：子/女
		name: "",
		title: "",
		birth_date: "",     // 向导内部用 YYYY-MM-DD，导出时转换
		lunar_birthday: "",
		zodiac: "",
		death_date: "",
		image_path: "",
		biography: ""
	};
}

function new_state() {
	let people = {};
	people[ME_ID] = empty_person(ME_ID);
	return {
		version: 2,
		me: ME_ID,
		next_id: 501,
		next_family: 1,
		page_key: "intro",
		page_index: 0,
		people: people,
		families: {},
		cover: { clan: "", motto: "" }
	};
}

function new_person(state, sex = "", rel = "") {
	let id = "I" + state.next_id++;
	state.people[id] = empty_person(id, sex, rel);
	return state.people[id];
}

function new_family(state, partners, children = []) {
	let id = "F" + state.next_family++;
	state.families[id] = { id: id, partners: partners, children: children };
	return state.families[id];
}

function is_named(state, id) {
	let person = id ? state.people[id] : null;
	return !!(person && String(person.name || "").trim());
}

function birth_family(state, id) {
	for (let fid in state.families)
		if (state.families[fid].children.includes(id)) return state.families[fid];
	return null;
}

function own_family(state, id) {
	for (let fid in state.families)
		if (state.families[fid].partners[0] === id) return state.families[fid];
	return null;
}

/** 确保某人有出生家庭（空白的父、母占位） */
function ensure_birth_family(state, id) {
	let family = birth_family(state, id);
	if (family) return family;
	let father = new_person(state, "M");
	let mother = new_person(state, "F");
	return new_family(state, [father.id, mother.id], [id]);
}

/** 确保某人有自己的家庭（空白的配偶占位） */
function ensure_own_family(state, id) {
	let family = own_family(state, id);
	if (family) return family;
	let spouse = new_person(state);
	return new_family(state, [id, spouse.id], []);
}

function add_child(state, parent_id, rel = "子") {
	let family = ensure_own_family(state, parent_id);
	let child = new_person(state, CHILD_RELS[rel] || "", rel);
	family.children.push(child.id);
	return child;
}

function add_sibling(state, rel = "兄") {
	let family = ensure_birth_family(state, state.me);
	let sibling = new_person(state, SIBLING_RELS[rel] || "", rel);
	family.children.push(sibling.id);
	return sibling;
}

function set_rel(state, id, rel) {
	let person = state.people[id];
	person.rel = rel;
	person.sex = SIBLING_RELS[rel] || CHILD_RELS[rel] || person.sex;
}

/** 删除一个子女或兄弟姐妹，连同其配偶和全部后代 */
function remove_person(state, id) {
	for (let fid in state.families) {
		let family = state.families[fid];
		family.children = family.children.filter(c => c !== id);
	}
	let family = own_family(state, id);
	if (family) {
		for (let child of family.children.slice()) remove_person(state, child);
		if (family.partners[1]) delete state.people[family.partners[1]];
		delete state.families[family.id];
	}
	delete state.people[id];
}

/** 推断性别：本人填写的 > 配偶取主方的相反性别 */
function sex_of(state, id) {
	let person = state.people[id];
	if (!person) return "";
	if (person.sex) return person.sex;
	for (let fid in state.families) {
		let family = state.families[fid];
		if (family.partners[1] === id) {
			let other = state.people[family.partners[0]];
			let other_sex = other ? other.sex : "";
			if (other_sex === "M") return "F";
			if (other_sex === "F") return "M";
		}
	}
	return "";
}

function named_siblings(state) {
	let family = birth_family(state, state.me);
	if (!family) return [];
	return family.children.filter(c => c !== state.me && is_named(state, c));
}

function has_named_parent(state, id) {
	let family = birth_family(state, id);
	return !!family && family.partners.some(p => is_named(state, p));
}

// ---------- 页面 ----------
/** 根据当前数据计算向导的全部页面（填写内容变化后页面会自动增减） */
function compute_pages(state) {
	let pages = [{ type: "intro", key: "intro" }, { type: "me", key: "me" }];
	if (is_named(state, state.me)) {
		// 祖先：逐代往上（广度优先），只有填了名字的人才继续追问其父母
		let queue = [state.me];
		while (queue.length) {
			let id = queue.shift();
			pages.push({ type: "parents", of: id, key: "parents:" + id });
			let family = birth_family(state, id);
			if (family)
				for (let parent of family.partners)
					if (is_named(state, parent)) queue.push(parent);
		}
		if (has_named_parent(state, state.me)) pages.push({ type: "siblings", key: "siblings" });
		// 后代：逐代往下（深度优先，一支问完再问下一支）
		let visit = id => {
			pages.push({ type: "family", of: id, key: "family:" + id });
			let family = own_family(state, id);
			if (family)
				for (let child of family.children)
					if (is_named(state, child)) visit(child);
		};
		visit(state.me);
		if (has_named_parent(state, state.me))
			for (let sibling of named_siblings(state)) visit(sibling);
	}
	pages.push({ type: "cover", key: "cover" }, { type: "done", key: "done" });
	return pages;
}

// ---------- 称谓 ----------
const ORDINALS = ["长", "次", "三", "四", "五", "六", "七", "八", "九", "十"];

function ancestor_title(depth, sex, via_female) {
	let base = sex === "F" ? "母" : "父";
	let prefix = via_female ? "外" : "";
	if (depth === 1) return sex === "F" ? "母亲" : "父亲";
	if (depth === 2) return prefix + "祖" + base;
	if (depth === 3) return prefix + "曾祖" + base;
	if (depth === 4) return prefix + "高祖" + base;
	return "先祖（上 " + depth + " 代）";
}

function descendant_title(depth, sex, via_female) {
	let prefix = via_female ? "外" : "";
	let girl = sex === "F";
	if (depth === 2) return prefix + (girl ? "孙女" : "孙子");
	if (depth === 3) return prefix + (girl ? "曾孙女" : "曾孙");
	if (depth === 4) return prefix + (girl ? "玄孙女" : "玄孙");
	return "后代（下 " + depth + " 代）";
}

const SPOUSE_TITLES = {
	"哥哥": "嫂子", "弟弟": "弟媳", "姐姐": "姐夫", "妹妹": "妹夫",
	"孙子": "孙媳", "孙女": "孙女婿", "外孙": "外孙媳", "外孙女": "外孙女婿",
	"侄子": "侄媳", "侄女": "侄女婿", "外甥": "外甥媳", "外甥女": "外甥女婿"
};

/** 计算每个人相对「我」的默认称谓：{ 成员ID: 称谓 } */
function kinship_titles(state) {
	let titles = {};
	let me = state.me;
	titles[me] = "本人";
	let label = id => (state.people[id] && String(state.people[id].name || "").trim()) || titles[id] || "";

	// 祖先：沿出生家庭往上
	let queue = [{ id: me, depth: 0, via_female: false }];
	while (queue.length) {
		let { id, depth, via_female } = queue.shift();
		let family = birth_family(state, id);
		if (!family) continue;
		// 「外」：路径中间（不含我和目标本人）出现女性
		let next_via_female = via_female || (depth > 0 && sex_of(state, id) === "F");
		for (let parent of family.partners) {
			if (!parent || titles[parent]) continue;
			titles[parent] = ancestor_title(depth + 1, sex_of(state, parent), next_via_female);
			queue.push({ id: parent, depth: depth + 1, via_female: next_via_female });
		}
	}

	// 一个人自己的家庭：配偶和子女（递归）
	let spouse_title = (id, primary_title) => {
		let info = lineage[id];
		if (info && info.kind === "me" && info.depth === 1) {
			let sex = sex_of(state, id);
			if (sex === "M") return "儿媳";
			if (sex === "F") return "女婿";
		}
		if (SPOUSE_TITLES[primary_title]) return SPOUSE_TITLES[primary_title];
		return label(id) ? label(id) + "的配偶" : "配偶";
	};
	let walk_family = (id, child_title) => {
		let family = own_family(state, id);
		if (!family) return;
		let spouse = family.partners[1];
		if (spouse && !titles[spouse]) titles[spouse] = spouse_title(id, titles[id]);
		let counters = { M: 0, F: 0, "": 0 };
		for (let child of family.children) {
			titles[child] = child_title(child, counters);
			walk_family(child, child_title_for(child));
		}
	};
	// 根据「我」与某个后代的关系，决定其子女的称谓
	let lineage = {}; // 成员ID -> { kind: "me"|"sibling", depth, via_female, root_rel }
	lineage[me] = { kind: "me", depth: 0, via_female: false };
	let child_title_for = parent => (child, counters) => {
		let info = lineage[parent];
		let sex = sex_of(state, child);
		let depth = info.depth + 1;
		let via_female = info.via_female || (info.depth > 0 && sex_of(state, parent) === "F");
		lineage[child] = { kind: info.kind, depth: depth, via_female: via_female, root_rel: info.root_rel };
		if (info.kind === "me") {
			if (depth === 1) {
				let rel = sex === "F" ? "女" : (sex === "M" ? "子" : "");
				if (!rel) return "子女";
				let index = counters[sex]++;
				return (index < ORDINALS.length ? ORDINALS[index] : String(index + 1)) + rel;
			}
			return descendant_title(depth, sex, via_female);
		}
		// 兄弟姐妹的后代
		let sister_line = info.root_rel === "姐" || info.root_rel === "妹";
		if (depth === 1) return sister_line ? (sex === "F" ? "外甥女" : "外甥") : (sex === "F" ? "侄女" : "侄子");
		if (depth === 2) return sister_line ? (sex === "F" ? "外甥孙女" : "外甥孙") : (sex === "F" ? "侄孙女" : "侄孙");
		return "侄辈后代";
	};

	// 我的配偶
	let my_family = own_family(state, me);
	if (my_family && my_family.partners[1]) {
		let my_sex = sex_of(state, me);
		titles[my_family.partners[1]] = my_sex === "M" ? "妻子" : (my_sex === "F" ? "丈夫" : "配偶");
	}
	walk_family(me, child_title_for(me));

	// 兄弟姐妹及其家庭
	let my_birth = birth_family(state, me);
	if (my_birth) {
		for (let sibling of my_birth.children) {
			if (sibling === me) continue;
			let rel = state.people[sibling] ? state.people[sibling].rel : "";
			titles[sibling] = { "兄": "哥哥", "弟": "弟弟", "姐": "姐姐", "妹": "妹妹" }[rel] || "兄弟姐妹";
			lineage[sibling] = { kind: "sibling", depth: 0, via_female: false, root_rel: rel };
			walk_family(sibling, child_title_for(sibling));
		}
	}
	return titles;
}

// ---------- 导出 ----------
// YYYY-MM-DD -> DD.MM.YYYY（与示例 input.js 一致）；其他格式原样保留
function to_export_date(value) {
	let text = String(value || "").trim();
	let match = text.match(/^(\d{4})-(\d{2})-(\d{2})$/);
	if (!match) return text;
	return match[3] + "." + match[2] + "." + match[1];
}

function extract_clan(name) {
	let text = String(name || "").trim();
	if (!text) return "";
	for (let surname of WIZARD_COMPOUND_SURNAMES)
		if (text.startsWith(surname)) return surname;
	return text[0];
}

/** 有效的家庭：至少一位有名字的父母/夫妻（否则兄弟姐妹之间无法连接），且有效成员不少于 2 人 */
function active_families(state) {
	let result = [];
	for (let fid in state.families) {
		let family = state.families[fid];
		let partners = family.partners.filter(p => is_named(state, p));
		let children = family.children.filter(c => is_named(state, c));
		if (partners.length >= 1 && partners.length + children.length >= 2)
			result.push({ id: fid, partners: partners, children: children });
	}
	return result;
}

/** 从「我」出发，经有效家庭能连到的人 */
function reachable_people(state, families) {
	let seen = new Set();
	if (!is_named(state, state.me)) return seen;
	let queue = [state.me];
	seen.add(state.me);
	while (queue.length) {
		let id = queue.shift();
		for (let family of families) {
			let members = family.partners.concat(family.children);
			if (!members.includes(id)) continue;
			for (let other of members)
				if (!seen.has(other)) {
					seen.add(other);
					queue.push(other);
				}
		}
	}
	return seen;
}

/** 代数最深的祖先（同样深时优先父系），PDF 的「第 1 世」从这里开始 */
function deepest_ancestor(state, included) {
	let best = { id: state.me, depth: 0 };
	let queue = [{ id: state.me, depth: 0 }];
	while (queue.length) {
		let { id, depth } = queue.shift();
		let family = birth_family(state, id);
		if (!family) continue;
		for (let parent of family.partners) {
			if (!included.has(parent)) continue;
			if (depth + 1 > best.depth) best = { id: parent, depth: depth + 1 };
			queue.push({ id: parent, depth: depth + 1 });
		}
	}
	return best.id;
}

/** 把向导状态转换为 _input 对象。返回 { input, errors }，errors 非空时 input 不可用。 */
function build_input(state) {
	let errors = [];
	if (!is_named(state, state.me)) errors.push("请先填写「我」的姓名。");
	let titles = kinship_titles(state);
	let families = active_families(state);
	let included = reachable_people(state, families);

	let members = {};
	let order = Object.keys(state.people).filter(id => included.has(id));
	for (let id of order) {
		let person = state.people[id];
		members[id] = {
			name: String(person.name || "").trim(),
			title: String(person.title || "").trim() || titles[id] || "",
			birth_date: to_export_date(person.birth_date),
			lunar_birthday: String(person.lunar_birthday || "").trim(),
			zodiac: person.zodiac || "",
			death_date: to_export_date(person.death_date),
			image_path: person.image_path || "",
			biography: String(person.biography || "").trim()
		};
	}

	// 家庭节点：夫妻 -> U 节点 -> 子女
	let links = [];
	let union_counter = 500;
	for (let family of families) {
		let partners = family.partners.filter(id => included.has(id));
		let children = family.children.filter(id => included.has(id));
		if (partners.length < 1 || partners.length + children.length < 2) continue;
		let union_id = "U" + union_counter++;
		for (let partner of partners) links.push([partner, union_id]);
		for (let child of children) links.push([union_id, child]);
	}

	if (errors.length === 0 && links.length === 0)
		errors.push("至少需要添加一位亲属（父母、配偶或子女），才能画出关系图。");

	let clan = String(state.cover.clan || "").trim() || extract_clan(state.people[state.me].name);
	let motto = String(state.cover.motto || "").trim() || DEFAULT_MOTTO;

	return {
		errors: errors,
		input: {
			start: deepest_ancestor(state, included),
			cover: { clan: clan, motto: motto },
			members: members,
			links: links
		}
	};
}

if (typeof module !== "undefined" && module.exports) {
	module.exports = {
		ME_ID, ZODIACS, DEFAULT_MOTTO, new_state, new_person, is_named,
		birth_family, own_family, ensure_birth_family, ensure_own_family,
		add_child, add_sibling, set_rel, remove_person, sex_of, has_named_parent,
		compute_pages, kinship_titles, build_input, extract_clan, to_export_date
	};
}
