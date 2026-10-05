import os, re
folder = r'C:\Users\abc\Desktop\Vercelx'
pattern = re.compile(r'window\.APP_CONFIG\s*=\s*\{\s*SIGNALING_URL:[^}]+\};\s*', re.DOTALL)
for f in os.listdir(folder):
    if f.endswith('.html'):
        path = os.path.join(folder, f)
        with open(path, 'r', encoding='utf-8') as file:
            content = file.read()
        new_content = pattern.sub('', content)
        if content != new_content:
            with open(path, 'w', encoding='utf-8') as file:
                file.write(new_content)
            print(f'Updated {f}')
