import dayjs from "dayjs";
import JSZip from "jszip";
import mime from "mime";
import type {AppMsgPublishResponse, PublishInfo, PublishPage} from "~/types/types";


export function proxyImage(url: string) {
    return `https://service.champ.design/api/proxy?url=${encodeURIComponent(url)}`
}

export function formatTimeStamp(timestamp: number) {
    return dayjs.unix(timestamp).format('YYYY-MM-DD HH:mm')
}

/**
 * 下载文章的 html
 * @param articleURL
 * @param title
 */
export async function downloadArticleHTML(articleURL: string, title?: string) {
    const fullHTML = await $fetch<string>('/api/download?url=' + encodeURIComponent(articleURL))

    // 验证是否正常
    const parser = new DOMParser()
    const document = parser.parseFromString(fullHTML, 'text/html')
    const $pageContent = document.querySelector('#page-content')
    if (!$pageContent) {
        if (title) {
            console.info(title)
        }
        throw new Error('下载失败，请重试')
    }
    return fullHTML
}

/**
 * 打包 html 中的资源
 * @param html
 * @param zip
 */
export async function packHTMLAssets(html: string, zip?: JSZip) {
    if (!zip) {
        zip = new JSZip();
    }

    const parser = new DOMParser()
    const document = parser.parseFromString(html, 'text/html')
    const $pageContent = document.querySelector('#page-content')!

    // #js_content 默认是不可见的(通过js修改为可见)，需要移除该样式
    $pageContent.querySelector('#js_content')?.removeAttribute('style')

    // 删除无用dom元素
    $pageContent.querySelector('#js_tags_preview_toast')?.remove()
    $pageContent.querySelector('#content_bottom_area')?.remove()
    $pageContent.querySelector('#js_temp_bottom_area')?.remove()
    $pageContent.querySelectorAll('script').forEach(el => {
        el.remove()
    })


    zip.folder('assets')


    // 下载所有的图片
    const imgs = $pageContent.querySelectorAll<HTMLImageElement>('img[src]')
    for (const img of imgs) {
        if (!img.src) {
            console.warn('img元素的src为空')
            continue
        }

        try {
            const imgData = await $fetch<Blob>(img.src)
            const uuid = new Date().getTime() + Math.random().toString()
            const ext = mime.getExtension(imgData.type)
            zip.file(`assets/${uuid}.${ext}`, imgData)

            // 改写html中的引用路径，指向本地图片文件
            img.src = `./assets/${uuid}.${ext}`
        } catch (e) {
            console.info('图片下载失败: ', img.src)
            console.error(e)
        }
    }


    // 下载背景图片
    // 背景图片无法用选择器选中并修改，因此用正则进行匹配替换
    let pageContentHTML = $pageContent.outerHTML
    const url2pathMap = new Map<string, string>()

    // 收集所有的背景图片地址
    const bgImageURLs = new Set<string>()
    pageContentHTML.replaceAll(/((?:background|background-image): url\((?:&quot;)?)((?:https?|\/\/)[^)]+?)((?:&quot;)?\))/gs, (match, p1, url, p3) => {
        bgImageURLs.add(url)
        return `${p1}${url}${p3}`
    })
    for (const url of bgImageURLs) {
        try {
            const imgData = await $fetch<Blob>(url)
            const uuid = new Date().getTime() + Math.random().toString()
            const ext = mime.getExtension(imgData.type)

            zip.file(`assets/${uuid}.${ext}`, imgData)
            url2pathMap.set(url, `assets/${uuid}.${ext}`)
        } catch (e) {
            console.info('背景图片下载失败: ', url)
            console.error(e)
        }
    }

    pageContentHTML = pageContentHTML.replaceAll(/((?:background|background-image): url\((?:&quot;)?)((?:https?|\/\/)[^)]+?)((?:&quot;)?\))/gs, (match, p1, url, p3) => {
        if (url2pathMap.has(url)) {
            const path = url2pathMap.get(url)!
            return `${p1}./${path}${p3}`
        } else {
            console.warn('背景图片丢失: ', url)
            return `${p1}${url}${p3}`
        }
    })

    // 下载样式表
    let localLinks: string = ''
    const links = document.querySelectorAll<HTMLLinkElement>('head link[rel="stylesheet"]')
    for (const link of links) {
        const url = link.href
        try {
            const stylesheet = await $fetch<string>(url)
            const uuid = new Date().getTime() + Math.random().toString()
            zip.file(`assets/${uuid}.css`, stylesheet)
            localLinks += `<link rel="stylesheet" href="./assets/${uuid}.css">`
        } catch (e) {
            console.info('样式表下载失败: ', url)
            console.error(e)
        }
    }

    const indexHTML = `<!DOCTYPE html>
<html lang="zh_CN">
<head>
    <meta charset="utf-8">
    <meta http-equiv="Content-Type" content="text/html; charset=utf-8">
    <meta http-equiv="X-UA-Compatible" content="IE=edge">
    <meta name="viewport" content="width=device-width,initial-scale=1.0,maximum-scale=1.0,user-scalable=0,viewport-fit=cover">
    ${localLinks}
    <style>
        #page-content {
            max-width: 667px;
            margin: 0 auto;
        }
        img {
            max-width: 100%;
        }
    </style>
</head>
<body>
${pageContentHTML}
</body>
</html>`

    zip.file('index.html', indexHTML)

    return zip
}

/**
 * 获取文章列表
 * @param fakeid
 * @param token
 * @param page
 * @param keyword
 */
export async function getArticleList(fakeid: string, token: string, page = 1, keyword = '') {
    const resp = await $fetch<AppMsgPublishResponse>('/api/appmsgpublish', {
        method: 'GET',
        query: {
            id: fakeid,
            token: token,
            page: page,
            size: 20,
            keyword: keyword,
        }
    })

    if (resp.base_resp.ret === 0) {
        const publish_page: PublishPage = JSON.parse(resp.publish_page)
        const publish_list = publish_page.publish_list.filter(item => !!item.publish_info)

        if (publish_list.length === 0) {
            // 全部加载完毕
            return []
        }
        return publish_list.flatMap(item => {
            const publish_info: PublishInfo = JSON.parse(item.publish_info)
            return publish_info.appmsgex
        })
    } else if (resp.base_resp.ret === 200003) {
        throw new Error('session expired')
    } else {
        throw new Error(resp.base_resp.err_msg)
    }
}
