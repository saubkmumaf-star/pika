import os, re
folder = r'C:\Users\abc\Desktop\Vercelx'
tag = '\n    <meta name="google-site-verification" content="cWO6WZvMeG6vo7ki8tR7gopvGfHbsyuqaTG81vWUrtU" />\n'
for f in os.listdir(folder):
    if f.endswith('.html'):
        path = os.path.join(folder, f)
        with open(path, 'r', encoding='utf-8') as file:
            content = file.read()
        if 'cWO6WZvMeG6vo7ki8tR7gopvGfHbsyuqaTG81vWUrtU' not in content:
            new_content = re.sub(r'(<head>)', r'\1' + tag, content, flags=re.IGNORECASE)
            with open(path, 'w', encoding='utf-8') as file:
                file.write(new_content)
            print(f'Updated {f}')
