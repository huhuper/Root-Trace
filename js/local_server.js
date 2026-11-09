/** 与本地启动器（start.py）通信：保存 input.js、上传照片、生成 PDF。 */
const LocalServer = (() => {
	const PHOTO_EXTENSIONS = ["jpg", "jpeg", "png", "gif", "webp", "bmp"];

	async function request(path, options = {}) {
		let response = await fetch(path, options);
		let data = {};
		try {
			data = await response.json();
		} catch (e) { /* 非 JSON 响应 */ }
		if (!response.ok || data.error)
			throw new Error(data.error || ("请求失败（HTTP " + response.status + "）"));
		return data;
	}

	/** 是否通过启动器打开（直接双击 HTML 时为 false） */
	async function ping() {
		if (location.protocol === "file:") return false;
		try {
			let data = await request("/api/ping");
			return data.app === "root-trace";
		} catch (e) {
			return false;
		}
	}

	function save_input(input) {
		return request("/api/input", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(input)
		});
	}

	function photo_extension(file) {
		let from_name = String(file.name || "").split(".").pop().toLowerCase();
		if (PHOTO_EXTENSIONS.includes(from_name)) return from_name;
		let from_type = String(file.type || "").split("/").pop().toLowerCase();
		if (PHOTO_EXTENSIONS.includes(from_type)) return from_type;
		return "jpg";
	}

	/** 上传照片，保存为 images/<成员ID>.<扩展名>，返回 { image_path } */
	function upload_photo(member_id, file) {
		let query = "id=" + encodeURIComponent(member_id) + "&ext=" + encodeURIComponent(photo_extension(file));
		return request("/api/photo?" + query, { method: "POST", body: file });
	}

	/** 用当前 input.js 生成 family_tree.pdf，返回 { url, summary } */
	function make_pdf() {
		return request("/api/pdf", { method: "POST" });
	}

	return { ping, save_input, upload_photo, make_pdf };
})();
